#include <node_api.h>

#include <cstdint>
#include <cstring>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#ifdef _WIN32
#include "native_fs_windows.inc"

#else

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__linux__)
#include <linux/fs.h>
#include <sys/random.h>
#include <sys/syscall.h>
#endif

namespace {

struct Root {
  int fd = -1;
  std::string canonical;
  dev_t dev = 0;
  ino_t ino = 0;
  ~Root() { if (fd >= 0) close(fd); }
};

struct Identity {
  dev_t dev = 0;
  ino_t ino = 0;
  off_t size = 0;
  int64_t mtime_ns = 0;
  int64_t ctime_ns = 0;
};

struct ExpectedIdentity {
  std::string dev;
  std::string ino;
  std::string size;
  std::string mtime_ns;
  std::string ctime_ns;
};

struct Source {
  int fd = -1;
  Identity identity;
  ~Source() { if (fd >= 0) close(fd); }
};

struct Stage {
  int fd = -1;
  std::string canonical;
  dev_t dev = 0;
  ino_t ino = 0;
  ~Stage() { if (fd >= 0) close(fd); }
};

struct Quarantine {
  int parent_fd = -1;
  std::shared_ptr<Stage> stage;
  std::string staged_name;
  std::string original_name;
  ~Quarantine() { if (parent_fd >= 0) close(parent_fd); }
};

std::mutex state_mutex;
uint64_t next_id = 1;
std::map<uint64_t, std::shared_ptr<Root>> roots;
std::map<uint64_t, std::shared_ptr<Source>> sources;
std::map<uint64_t, std::shared_ptr<Quarantine>> quarantines;
std::shared_ptr<Stage> stage;
std::vector<std::shared_ptr<Stage>> stages;
bool PathOfDirectoryFd(int fd, std::string* path);

bool LiveStage(const Stage& item) {
  struct stat st{};
  std::string live_path;
  return fstat(item.fd, &st) == 0 && PathOfDirectoryFd(item.fd, &live_path);
}

int64_t MtimeNs(const struct stat& st) {
#if defined(__APPLE__)
  return static_cast<int64_t>(st.st_mtimespec.tv_sec) * 1000000000LL + st.st_mtimespec.tv_nsec;
#else
  return static_cast<int64_t>(st.st_mtim.tv_sec) * 1000000000LL + st.st_mtim.tv_nsec;
#endif
}

int64_t CtimeNs(const struct stat& st) {
#if defined(__APPLE__)
  return static_cast<int64_t>(st.st_ctimespec.tv_sec) * 1000000000LL + st.st_ctimespec.tv_nsec;
#else
  return static_cast<int64_t>(st.st_ctim.tv_sec) * 1000000000LL + st.st_ctim.tv_nsec;
#endif
}

Identity IdentityOf(const struct stat& st) {
  return {st.st_dev, st.st_ino, st.st_size, MtimeNs(st), CtimeNs(st)};
}

bool SameIdentity(const Identity& a, const Identity& b) {
  return a.dev == b.dev && a.ino == b.ino && a.size == b.size &&
         a.mtime_ns == b.mtime_ns && a.ctime_ns == b.ctime_ns;
}

bool SameIdentity(const struct stat& st, const ExpectedIdentity& expected) {
  return S_ISREG(st.st_mode) &&
         std::to_string(static_cast<uint64_t>(st.st_dev)) == expected.dev &&
         std::to_string(static_cast<uint64_t>(st.st_ino)) == expected.ino &&
         std::to_string(static_cast<int64_t>(st.st_size)) == expected.size &&
         std::to_string(MtimeNs(st)) == expected.mtime_ns &&
         std::to_string(CtimeNs(st)) == expected.ctime_ns;
}

const char* ErrnoCode(int value) {
  switch (value) {
    case EACCES: return "EACCES";
    case EEXIST: return "EEXIST";
    case EINVAL: return "EINVAL";
    case EIO: return "EIO";
    case EISDIR: return "EISDIR";
    case ELOOP: return "ELOOP";
    case EMFILE: return "EMFILE";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ENFILE: return "ENFILE";
    case ENOENT: return "ENOENT";
    case ENOSPC: return "ENOSPC";
    case ENOTDIR: return "ENOTDIR";
    case ENOTSUP: return "ENOTSUP";
    case EPERM: return "EPERM";
    case EXDEV: return "EXDEV";
    default: return "NATIVE_FS_ERROR";
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

napi_value ThrowErrno(napi_env env, const std::string& action, int value = errno) {
  return Throw(env, ErrnoCode(value), action + ": " + std::strerror(value));
}

bool GetString(napi_env env, napi_value value, std::string* out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  out->resize(length);
  size_t copied = 0;
  return napi_get_value_string_utf8(env, value, out->data(), length + 1, &copied) == napi_ok;
}

bool GetId(napi_env env, napi_value value, uint64_t* out) {
  bool lossless = false;
  return napi_get_value_bigint_uint64(env, value, out, &lossless) == napi_ok && lossless;
}

bool GetBool(napi_env env, napi_value value, bool* out) {
  return napi_get_value_bool(env, value, out) == napi_ok;
}

bool GetNamedString(napi_env env, napi_value object, const char* name, std::string* out) {
  napi_value value;
  return napi_get_named_property(env, object, name, &value) == napi_ok && GetString(env, value, out);
}

bool GetExpectedIdentity(napi_env env, napi_value value, ExpectedIdentity* out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object) return false;
  return GetNamedString(env, value, "dev", &out->dev) &&
         GetNamedString(env, value, "ino", &out->ino) &&
         GetNamedString(env, value, "size", &out->size) &&
         GetNamedString(env, value, "mtimeNs", &out->mtime_ns) &&
         GetNamedString(env, value, "ctimeNs", &out->ctime_ns);
}

bool GetUint8(napi_env env, napi_value value, uint8_t** data, size_t* length) {
  bool is_buffer = false;
  napi_is_buffer(env, value, &is_buffer);
  if (is_buffer) return napi_get_buffer_info(env, value, reinterpret_cast<void**>(data), length) == napi_ok;
  bool is_typed = false;
  napi_is_typedarray(env, value, &is_typed);
  if (!is_typed) return false;
  napi_typedarray_type type;
  size_t elements = 0;
  void* raw = nullptr;
  napi_value array_buffer;
  size_t offset = 0;
  if (napi_get_typedarray_info(env, value, &type, &elements, &raw, &array_buffer, &offset) != napi_ok ||
      type != napi_uint8_array) return false;
  *data = static_cast<uint8_t*>(raw);
  *length = elements;
  return true;
}

std::shared_ptr<Root> FindRoot(uint64_t id) {
  std::lock_guard<std::mutex> lock(state_mutex);
  auto it = roots.find(id);
  return it == roots.end() ? nullptr : it->second;
}

std::shared_ptr<Source> FindSource(uint64_t id) {
  std::lock_guard<std::mutex> lock(state_mutex);
  auto it = sources.find(id);
  return it == sources.end() ? nullptr : it->second;
}

std::shared_ptr<Quarantine> FindQuarantine(uint64_t id) {
  std::lock_guard<std::mutex> lock(state_mutex);
  auto it = quarantines.find(id);
  return it == quarantines.end() ? nullptr : it->second;
}

int DupCloexec(int fd);

bool IsStage(const struct stat& st) {
  std::lock_guard<std::mutex> lock(state_mutex);
  for (const auto& item : stages)
    if (LiveStage(*item) && item->dev == st.st_dev && item->ino == st.st_ino) return true;
  return false;
}

// Return 1 when ancestor is the same directory as, or an ancestor of, child.
// Walking `..` from the held child descriptor keeps this an object comparison;
// aliases and pathname replacement cannot change the answer.
int IsDirectoryAncestor(dev_t ancestor_dev, ino_t ancestor_ino, int child_fd) {
  int current = DupCloexec(child_fd);
  if (current < 0) return -1;
  for (;;) {
    struct stat here{};
    if (fstat(current, &here) != 0) { int saved = errno; close(current); errno = saved; return -1; }
    if (here.st_dev == ancestor_dev && here.st_ino == ancestor_ino) { close(current); return 1; }
    int parent = openat(current, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent < 0) { int saved = errno; close(current); errno = saved; return -1; }
    struct stat above{};
    if (fstat(parent, &above) != 0) {
      int saved = errno; close(parent); close(current); errno = saved; return -1;
    }
    if (above.st_dev == here.st_dev && above.st_ino == here.st_ino) {
      close(parent); close(current); return 0;
    }
    close(current);
    current = parent;
  }
}

int IsDirectoryAncestor(const Root& ancestor, int child_fd) {
  return IsDirectoryAncestor(ancestor.dev, ancestor.ino, child_fd);
}

bool SplitRelative(const std::string& path, bool allow_empty, std::vector<std::string>* parts) {
  if (path.empty()) return allow_empty;
  if (path.front() == '/') return false;
  size_t start = 0;
  while (start <= path.size()) {
    size_t end = path.find('/', start);
    if (end == std::string::npos) end = path.size();
    std::string part = path.substr(start, end - start);
    if (part.empty() || part == "." || part == ".." || part.find('\0') != std::string::npos) return false;
    parts->push_back(std::move(part));
    if (end == path.size()) break;
    start = end + 1;
  }
  return true;
}

int DupCloexec(int fd) {
#ifdef F_DUPFD_CLOEXEC
  return fcntl(fd, F_DUPFD_CLOEXEC, 0);
#else
  int copy = dup(fd);
  if (copy >= 0) fcntl(copy, F_SETFD, FD_CLOEXEC);
  return copy;
#endif
}

int OpenDirectoryAt(int parent, const std::string& name) {
  int fd = openat(parent, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat st{};
  if (fstat(fd, &st) != 0 || !S_ISDIR(st.st_mode) || IsStage(st)) {
    int saved = errno ? errno : EACCES;
    close(fd);
    errno = saved;
    return -1;
  }
  return fd;
}

int OpenDirectory(const Root& root, const std::vector<std::string>& parts, size_t count) {
  // dup() shares a directory stream offset with the pinned root descriptor;
  // opening "." creates an independent description so repeated list calls do
  // not inherit EOF from an earlier fdopendir/readdir.
  int current = openat(root.fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0) return -1;
  for (size_t i = 0; i < count; ++i) {
    int next = OpenDirectoryAt(current, parts[i]);
    int saved = errno;
    close(current);
    if (next < 0) {
      errno = saved;
      return -1;
    }
    current = next;
  }
  return current;
}

bool StatRelative(const Root& root, const std::vector<std::string>& parts, struct stat* st) {
  if (parts.empty()) return fstat(root.fd, st) == 0;
  int parent = OpenDirectory(root, parts, parts.size() - 1);
  if (parent < 0) return false;
  int result = fstatat(parent, parts.back().c_str(), st, AT_SYMLINK_NOFOLLOW);
  int saved = errno;
  close(parent);
  errno = saved;
  if (result != 0) return false;
  if (IsStage(*st)) { errno = EACCES; return false; }
  return true;
}

std::string TypeOf(mode_t mode) {
  if (S_ISREG(mode)) return "file";
  if (S_ISDIR(mode)) return "directory";
  if (S_ISLNK(mode)) return "symlink";
  return "other";
}

void SetString(napi_env env, napi_value object, const char* key, const std::string& value) {
  napi_value item;
  napi_create_string_utf8(env, value.c_str(), value.size(), &item);
  napi_set_named_property(env, object, key, item);
}

void SetNumber(napi_env env, napi_value object, const char* key, double value) {
  napi_value item;
  napi_create_double(env, value, &item);
  napi_set_named_property(env, object, key, item);
}

napi_value StatObject(napi_env env, const struct stat& st) {
  napi_value result;
  napi_create_object(env, &result);
  SetString(env, result, "type", TypeOf(st.st_mode));
  SetNumber(env, result, "size", static_cast<double>(st.st_size));
  SetNumber(env, result, "mtimeMs", static_cast<double>(MtimeNs(st)) / 1000000.0);
  SetString(env, result, "mtimeNs", std::to_string(MtimeNs(st)));
  SetString(env, result, "ctimeNs", std::to_string(CtimeNs(st)));
  SetString(env, result, "dev", std::to_string(static_cast<uint64_t>(st.st_dev)));
  SetString(env, result, "ino", std::to_string(static_cast<uint64_t>(st.st_ino)));
  SetNumber(env, result, "mode", static_cast<double>(st.st_mode & 07777));
  return result;
}

int OpenCanonicalDirectory(const std::string& canonical) {
  if (canonical.empty() || canonical.front() != '/') { errno = EINVAL; return -1; }
  int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0) return -1;
  std::vector<std::string> parts;
  if (!SplitRelative(canonical.substr(1), true, &parts)) {
    close(current); errno = EINVAL; return -1;
  }
  for (const auto& part : parts) {
    int next = openat(current, part.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int saved = errno;
    close(current);
    if (next < 0) { errno = saved; return -1; }
    struct stat st{};
    if (fstat(next, &st) != 0 || !S_ISDIR(st.st_mode)) {
      saved = errno ? errno : ENOTDIR; close(next); errno = saved; return -1;
    }
    current = next;
  }
  return current;
}

bool Args(napi_env env, napi_callback_info info, size_t expected, std::vector<napi_value>* args) {
  size_t count = expected;
  args->resize(expected);
  if (napi_get_cb_info(env, info, &count, args->data(), nullptr, nullptr) != napi_ok || count < expected) {
    Throw(env, "EINVAL", "native-fs argument missing");
    return false;
  }
  return true;
}

bool RootAndPath(napi_env env, const std::vector<napi_value>& args, bool empty,
                 std::shared_ptr<Root>* root, std::vector<std::string>* parts) {
  uint64_t id = 0;
  std::string path;
  if (!GetId(env, args[0], &id) || !GetString(env, args[1], &path)) {
    Throw(env, "EINVAL", "invalid root or relative path");
    return false;
  }
  *root = FindRoot(id);
  if (!*root) {
    Throw(env, "NATIVE_ROOT_CLOSED", "root grant is closed");
    return false;
  }
  if (!SplitRelative(path, empty, parts)) {
    Throw(env, "PATH_DOMAIN_MISMATCH", "relative path contains an invalid component");
    return false;
  }
  return true;
}

napi_value OpenRoot(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 1, &args)) return nullptr;
  std::string input;
  if (!GetString(env, args[0], &input)) return Throw(env, "EINVAL", "root path must be a string");
  char canonical[PATH_MAX];
  if (!realpath(input.c_str(), canonical)) return ThrowErrno(env, "realpath root");
  int fd = OpenCanonicalDirectory(canonical);
  if (fd < 0) return ThrowErrno(env, "open root");
  struct stat st{};
  if (fstat(fd, &st) != 0 || !S_ISDIR(st.st_mode)) {
    int saved = errno ? errno : ENOTDIR;
    close(fd);
    return ThrowErrno(env, "stat root", saved);
  }
  auto root = std::make_shared<Root>();
  root->fd = fd;
  root->canonical = canonical;
  root->dev = st.st_dev;
  root->ino = st.st_ino;
  uint64_t id;
  {
    std::lock_guard<std::mutex> lock(state_mutex);
    for (const auto& current_stage : stages) {
      if (!LiveStage(*current_stage)) continue;
      int root_contains_stage = IsDirectoryAncestor(*root, current_stage->fd);
      int root_contains_stage_error = errno;
      int stage_contains_root = IsDirectoryAncestor(current_stage->dev, current_stage->ino, root->fd);
      int stage_contains_root_error = errno;
      if (root_contains_stage != 0 || stage_contains_root != 0) {
        int saved = root_contains_stage < 0 ? root_contains_stage_error
          : stage_contains_root < 0 ? stage_contains_root_error : EACCES;
        return ThrowErrno(env, "root grant must be disjoint from the private stage", saved);
      }
    }
    id = next_id++;
    roots[id] = root;
  }
  napi_value result, js_id;
  napi_create_object(env, &result);
  napi_create_bigint_uint64(env, id, &js_id);
  napi_set_named_property(env, result, "id", js_id);
  SetString(env, result, "canonicalPath", root->canonical);
  SetString(env, result, "dev", std::to_string(static_cast<uint64_t>(st.st_dev)));
  SetString(env, result, "ino", std::to_string(static_cast<uint64_t>(st.st_ino)));
  return result;
}

napi_value CloseRoot(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 1, &args)) return nullptr;
  uint64_t id;
  if (!GetId(env, args[0], &id)) return Throw(env, "EINVAL", "invalid root id");
  std::lock_guard<std::mutex> lock(state_mutex);
  roots.erase(id);
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

napi_value Stat(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 2, &args)) return nullptr;
  std::shared_ptr<Root> root;
  std::vector<std::string> parts;
  if (!RootAndPath(env, args, true, &root, &parts)) return nullptr;
  struct stat st{};
  if (!StatRelative(*root, parts, &st)) return ThrowErrno(env, "rooted stat");
  return StatObject(env, st);
}

napi_value List(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 2, &args)) return nullptr;
  std::shared_ptr<Root> root;
  std::vector<std::string> parts;
  if (!RootAndPath(env, args, true, &root, &parts)) return nullptr;
  int fd = OpenDirectory(*root, parts, parts.size());
  if (fd < 0) return ThrowErrno(env, "open rooted directory");
  DIR* directory = fdopendir(fd);
  if (!directory) {
    int saved = errno;
    close(fd);
    return ThrowErrno(env, "read rooted directory", saved);
  }
  napi_value array;
  napi_create_array(env, &array);
  uint32_t index = 0;
  int saved = 0;
  for (;;) {
    errno = 0;
    dirent* entry = readdir(directory);
    if (!entry) { saved = errno; break; }
    std::string name(entry->d_name);
    if (name == "." || name == "..") continue;
    struct stat st{};
    if (fstatat(fd, name.c_str(), &st, AT_SYMLINK_NOFOLLOW) != 0 || IsStage(st)) continue;
    napi_value item = StatObject(env, st);
    SetString(env, item, "name", name);
    napi_set_element(env, array, index++, item);
  }
  closedir(directory);
  if (saved) return ThrowErrno(env, "read rooted directory", saved);
  return array;
}

napi_value Mkdirs(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 2, &args)) return nullptr;
  std::shared_ptr<Root> root;
  std::vector<std::string> parts;
  if (!RootAndPath(env, args, true, &root, &parts)) return nullptr;
  int current = DupCloexec(root->fd);
  if (current < 0) return ThrowErrno(env, "duplicate root");
  for (const auto& part : parts) {
    int next = OpenDirectoryAt(current, part);
    if (next < 0 && errno == ENOENT) {
      if (mkdirat(current, part.c_str(), 0777) != 0 && errno != EEXIST) {
        int saved = errno; close(current); return ThrowErrno(env, "create rooted directory", saved);
      }
      next = OpenDirectoryAt(current, part);
    }
    if (next < 0) {
      int saved = errno; close(current); return ThrowErrno(env, "open rooted directory", saved);
    }
    close(current);
    current = next;
  }
  close(current);
  napi_value value; napi_get_undefined(env, &value); return value;
}

napi_value Write(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 4, &args)) return nullptr;
  std::shared_ptr<Root> root;
  std::vector<std::string> parts;
  if (!RootAndPath(env, args, false, &root, &parts)) return nullptr;
  uint8_t* data = nullptr; size_t length = 0; bool append = false;
  if (!GetUint8(env, args[2], &data, &length) || !GetBool(env, args[3], &append))
    return Throw(env, "EINVAL", "invalid write data");
  int parent = OpenDirectory(*root, parts, parts.size() - 1);
  if (parent < 0) return ThrowErrno(env, "open rooted parent");
  int flags = O_WRONLY | O_CREAT | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC | (append ? O_APPEND : O_TRUNC);
  int fd = openat(parent, parts.back().c_str(), flags, 0666);
  int saved = errno;
  close(parent);
  if (fd < 0) return ThrowErrno(env, "open rooted file", saved);
  struct stat st{};
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) {
    saved = errno ? errno : EINVAL; close(fd); return ThrowErrno(env, "rooted file is not regular", saved);
  }
  size_t written = 0;
  while (written < length) {
    ssize_t n = write(fd, data + written, length - written);
    if (n <= 0) { saved = n < 0 ? errno : EIO; close(fd); return ThrowErrno(env, "write rooted file", saved); }
    written += static_cast<size_t>(n);
  }
  if (close(fd) != 0) return ThrowErrno(env, "close rooted file");
  napi_value value; napi_get_undefined(env, &value); return value;
}

napi_value WriteExpected(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 4, &args)) return nullptr;
  std::shared_ptr<Root> root;
  std::vector<std::string> parts;
  if (!RootAndPath(env, args, false, &root, &parts)) return nullptr;
  uint8_t* data = nullptr; size_t length = 0;
  ExpectedIdentity expected{};
  if (!GetUint8(env, args[2], &data, &length) || !GetExpectedIdentity(env, args[3], &expected))
    return Throw(env, "EINVAL", "invalid expected write arguments");
  int parent = OpenDirectory(*root, parts, parts.size() - 1);
  if (parent < 0) return ThrowErrno(env, "open expected write parent");
  int fd = openat(parent, parts.back().c_str(), O_WRONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  int saved = errno;
  close(parent);
  if (fd < 0) return ThrowErrno(env, "open expected write target", saved);
  struct stat before{};
  if (fstat(fd, &before) != 0 || !SameIdentity(before, expected)) {
    close(fd); return Throw(env, "FILE_SOURCE_CHANGED", "expected write target changed");
  }
  if (ftruncate(fd, 0) != 0) {
    saved = errno; close(fd); return ThrowErrno(env, "truncate expected write target", saved);
  }
  size_t written = 0;
  while (written < length) {
    ssize_t count = write(fd, data + written, length - written);
    if (count <= 0) {
      saved = count < 0 ? errno : EIO; close(fd); return ThrowErrno(env, "write expected target", saved);
    }
    written += static_cast<size_t>(count);
  }
  if (fsync(fd) != 0) { saved = errno; close(fd); return ThrowErrno(env, "sync expected target", saved); }
  close(fd);
  napi_value value; napi_get_undefined(env, &value); return value;
}

napi_value SetMode(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 3, &args)) return nullptr;
  std::shared_ptr<Root> root;
  std::vector<std::string> parts;
  if (!RootAndPath(env, args, false, &root, &parts)) return nullptr;
  int32_t mode = 0;
  if (napi_get_value_int32(env, args[2], &mode) != napi_ok || mode < 0 || mode > 07777)
    return Throw(env, "EINVAL", "invalid mode");
  int parent = OpenDirectory(*root, parts, parts.size() - 1);
  if (parent < 0) return ThrowErrno(env, "open chmod parent");
  int fd = openat(parent, parts.back().c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_DIRECTORY);
  int saved = errno;
  close(parent);
  if (fd < 0) return ThrowErrno(env, "open chmod directory", saved);
  if (fchmod(fd, static_cast<mode_t>(mode & 0777)) != 0) {
    saved = errno; close(fd); return ThrowErrno(env, "chmod rooted directory", saved);
  }
  close(fd);
  napi_value value; napi_get_undefined(env, &value); return value;
}

napi_value RegisterSource(napi_env env, int fd) {
  struct stat st{};
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) {
    int saved = errno ? errno : EINVAL; close(fd); return ThrowErrno(env, "source is not a regular file", saved);
  }
  auto source = std::make_shared<Source>();
  source->fd = fd;
  source->identity = IdentityOf(st);
  uint64_t id;
  {
    std::lock_guard<std::mutex> lock(state_mutex);
    id = next_id++;
    sources[id] = source;
  }
  napi_value result = StatObject(env, st), js_id;
  napi_create_bigint_uint64(env, id, &js_id);
  napi_set_named_property(env, result, "id", js_id);
  return result;
}

napi_value OpenSource(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 2, &args)) return nullptr;
  std::shared_ptr<Root> root;
  std::vector<std::string> parts;
  if (!RootAndPath(env, args, false, &root, &parts)) return nullptr;
  int parent = OpenDirectory(*root, parts, parts.size() - 1);
  if (parent < 0) return ThrowErrno(env, "open rooted source parent");
  int fd = openat(parent, parts.back().c_str(), O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  int saved = errno;
  close(parent);
  if (fd < 0) return ThrowErrno(env, "open rooted source", saved);
  return RegisterSource(env, fd);
}

napi_value OpenStageSource(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 1, &args)) return nullptr;
  std::string relative;
  if (!GetString(env, args[0], &relative)) return Throw(env, "EINVAL", "stage source path must be a string");
  std::vector<std::string> parts;
  if (!SplitRelative(relative, false, &parts))
    return Throw(env, "PATH_DOMAIN_MISMATCH", "stage source path contains an invalid component");
  std::shared_ptr<Stage> default_stage;
  {
    std::lock_guard<std::mutex> lock(state_mutex);
    default_stage = stage;
    if (default_stage) {
      for (const auto& grant : roots) {
        int grant_contains_stage = IsDirectoryAncestor(*grant.second, default_stage->fd);
        int stage_contains_grant = IsDirectoryAncestor(default_stage->dev, default_stage->ino, grant.second->fd);
        if (grant_contains_stage != 0 || stage_contains_grant != 0)
          return Throw(env, "EACCES", "default private stage intersects a root grant");
      }
    }
  }
  if (!default_stage) return Throw(env, "WORKSPACE_ATOMIC_STAGE_UNCONFIGURED", "private stage directory is not configured");
  struct stat stage_st{};
  if (fstat(default_stage->fd, &stage_st) != 0 || !S_ISDIR(stage_st.st_mode) ||
      stage_st.st_uid != geteuid() || (stage_st.st_mode & 0077) != 0 ||
      !LiveStage(*default_stage))
    return Throw(env, "EACCES", "default private stage is not available");
  int parent = DupCloexec(default_stage->fd);
  if (parent < 0) return ThrowErrno(env, "duplicate private stage");
  for (size_t i = 0; i + 1 < parts.size(); ++i) {
    int next = OpenDirectoryAt(parent, parts[i]);
    int saved = errno;
    close(parent);
    if (next < 0) return ThrowErrno(env, "open private stage directory", saved);
    parent = next;
  }
  int fd = openat(parent, parts.back().c_str(), O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  int saved = errno;
  close(parent);
  if (fd < 0) return ThrowErrno(env, "open private stage source", saved);
  return RegisterSource(env, fd);
}

napi_value ReadSource(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 3, &args)) return nullptr;
  uint64_t id = 0; int64_t offset = 0; int64_t requested = 0;
  if (!GetId(env, args[0], &id) || napi_get_value_int64(env, args[1], &offset) != napi_ok ||
      napi_get_value_int64(env, args[2], &requested) != napi_ok || offset < 0 || requested < 0)
    return Throw(env, "EINVAL", "invalid source read range");
  auto source = FindSource(id);
  if (!source) return Throw(env, "NATIVE_SOURCE_CLOSED", "source handle is closed");
  struct stat before{};
  if (fstat(source->fd, &before) != 0 || !SameIdentity(IdentityOf(before), source->identity))
    return Throw(env, "FILE_SOURCE_CHANGED", "source identity changed before read");
  uint64_t available = offset >= source->identity.size ? 0 : static_cast<uint64_t>(source->identity.size - offset);
  size_t length = static_cast<size_t>(std::min<uint64_t>(available, static_cast<uint64_t>(requested)));
  void* raw = nullptr; napi_value buffer;
  if (napi_create_buffer(env, length, &raw, &buffer) != napi_ok) return Throw(env, "ENOMEM", "allocate read buffer");
  size_t got = 0;
  while (got < length) {
    ssize_t n = pread(source->fd, static_cast<uint8_t*>(raw) + got, length - got, offset + got);
    if (n < 0) return ThrowErrno(env, "read source");
    if (n == 0) break;
    got += static_cast<size_t>(n);
  }
  struct stat after{};
  if (fstat(source->fd, &after) != 0 || !SameIdentity(IdentityOf(after), source->identity) || got != length)
    return Throw(env, "FILE_SOURCE_CHANGED", "source identity changed during read");
  if (got == length) return buffer;
  return Throw(env, "FILE_SOURCE_CHANGED", "short source read");
}

napi_value StatSource(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 1, &args)) return nullptr;
  uint64_t id = 0;
  if (!GetId(env, args[0], &id)) return Throw(env, "EINVAL", "invalid source id");
  auto source = FindSource(id);
  if (!source) return Throw(env, "NATIVE_SOURCE_CLOSED", "source handle is closed");
  struct stat st{};
  if (fstat(source->fd, &st) != 0 || !SameIdentity(IdentityOf(st), source->identity))
    return Throw(env, "FILE_SOURCE_CHANGED", "source identity changed");
  return StatObject(env, st);
}

napi_value CloseSource(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 1, &args)) return nullptr;
  uint64_t id;
  if (!GetId(env, args[0], &id)) return Throw(env, "EINVAL", "invalid source id");
  std::lock_guard<std::mutex> lock(state_mutex);
  sources.erase(id);
  napi_value value; napi_get_undefined(env, &value); return value;
}

napi_value ConfigureStage(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 1, &args)) return nullptr;
  std::string input;
  if (!GetString(env, args[0], &input)) return Throw(env, "EINVAL", "stage path must be a string");
  char canonical[PATH_MAX];
  if (!realpath(input.c_str(), canonical)) return ThrowErrno(env, "realpath stage");
  int fd = OpenCanonicalDirectory(canonical);
  if (fd < 0) return ThrowErrno(env, "open stage");
  struct stat st{};
  if (fstat(fd, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 0077) != 0) {
    int saved = errno ? errno : EACCES;
    close(fd);
    return ThrowErrno(env, "stage directory is not private", saved);
  }
  auto value = std::make_shared<Stage>();
  value->fd = fd; value->canonical = canonical; value->dev = st.st_dev; value->ino = st.st_ino;
  {
    std::lock_guard<std::mutex> lock(state_mutex);
    for (const auto& item : roots) {
      int grant_contains_stage = IsDirectoryAncestor(*item.second, value->fd);
      int grant_contains_stage_error = errno;
      int stage_contains_grant = IsDirectoryAncestor(value->dev, value->ino, item.second->fd);
      int stage_contains_grant_error = errno;
      if (grant_contains_stage != 0 || stage_contains_grant != 0) {
        int saved = grant_contains_stage < 0 ? grant_contains_stage_error
          : stage_contains_grant < 0 ? stage_contains_grant_error : EACCES;
        return ThrowErrno(env, "private stage must be disjoint from every root grant", saved);
      }
    }
    stage = value;
    stages.push_back(value);
  }
  napi_value result;
  napi_create_string_utf8(env, canonical, NAPI_AUTO_LENGTH, &result);
  return result;
}

bool RandomName(std::string* name) {
  uint8_t bytes[16];
#if defined(__APPLE__)
  arc4random_buf(bytes, sizeof(bytes));
#elif defined(__linux__)
  if (getrandom(bytes, sizeof(bytes), 0) != static_cast<ssize_t>(sizeof(bytes))) return false;
#else
  int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return false;
  ssize_t got = read(fd, bytes, sizeof(bytes));
  close(fd);
  if (got != static_cast<ssize_t>(sizeof(bytes))) return false;
#endif
  static const char hex[] = "0123456789abcdef";
  *name = ".xgen-stage-";
  for (uint8_t byte : bytes) {
    name->push_back(hex[byte >> 4]);
    name->push_back(hex[byte & 15]);
  }
  return true;
}

// Resolve a pinned directory for a trusted OS-path handoff. A stale root
// pathname cannot be used here: the grant may have been renamed.
bool PathOfDirectoryFd(int fd, std::string* path) {
#if defined(__APPLE__)
  char buffer[PATH_MAX];
  if (fcntl(fd, F_GETPATH, buffer) != 0) return false;
  *path = buffer;
#elif defined(__linux__)
  char buffer[PATH_MAX];
  ssize_t count = readlink(("/proc/self/fd/" + std::to_string(fd)).c_str(), buffer, sizeof(buffer) - 1);
  if (count < 0 || count >= static_cast<ssize_t>(sizeof(buffer) - 1)) return false;
  buffer[count] = '\0';
  *path = buffer;
  if (path->find(" (deleted)") != std::string::npos) { errno = ENOENT; return false; }
#else
  errno = ENOTSUP;
  return false;
#endif
  int check = OpenCanonicalDirectory(*path);
  if (check < 0) return false;
  struct stat first{}, second{};
  bool same = fstat(fd, &first) == 0 && fstat(check, &second) == 0 &&
              first.st_dev == second.st_dev && first.st_ino == second.st_ino;
  close(check);
  if (!same) errno = EACCES;
  return same;
}

// Called with state_mutex held. The stage is a private sibling outside every
// active grant, on the target filesystem. If the grant covers an entire
// volume there is no safe parent on that volume and this fails closed.
std::shared_ptr<Stage> StageForDeviceLocked(int target_parent, dev_t target_dev) {
  for (auto iter = stages.rbegin(); iter != stages.rend(); ++iter) {
    const auto& item = *iter;
    if (item->dev != target_dev) continue;
    std::string live_path;
    if (PathOfDirectoryFd(item->fd, &live_path)) {
      for (const auto& grant : roots) {
        int grant_contains_stage = IsDirectoryAncestor(*grant.second, item->fd);
        int stage_contains_grant = IsDirectoryAncestor(item->dev, item->ino, grant.second->fd);
        if (grant_contains_stage != 0 || stage_contains_grant != 0) {
          errno = EACCES;
          return nullptr;
        }
      }
      item->canonical = live_path;
      return item;
    }
  }
  if (!stage) { errno = ENOTSUP; return nullptr; }
  int cursor = DupCloexec(target_parent);
  if (cursor < 0) return nullptr;
  for (;;) {
    struct stat here{};
    if (fstat(cursor, &here) != 0) break;
    if (here.st_dev != target_dev) { errno = ENOTSUP; break; }
    bool within_grant = false;
    for (const auto& item : roots) {
      int inside = IsDirectoryAncestor(*item.second, cursor);
      if (inside < 0) {
        int saved = errno; close(cursor); errno = saved; return nullptr;
      }
      if (inside == 1) { within_grant = true; break; }
    }
    if (!within_grant) {
      std::string parent_path;
      if (PathOfDirectoryFd(cursor, &parent_path)) {
        for (int attempt = 0; attempt < 16; ++attempt) {
          std::string name;
          if (!RandomName(&name)) break;
          if (mkdirat(cursor, name.c_str(), 0700) != 0) {
            if (errno == EEXIST) continue;
            break;
          }
          int fd = openat(cursor, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
          struct stat created{};
          if (fd < 0 || fstat(fd, &created) != 0 || created.st_dev != target_dev ||
              created.st_uid != geteuid() || (created.st_mode & 0077) != 0) {
            int saved = errno ? errno : EACCES;
            if (fd >= 0) close(fd);
            unlinkat(cursor, name.c_str(), AT_REMOVEDIR);
            errno = saved;
            break;
          }
          auto value = std::make_shared<Stage>();
          value->fd = fd; value->dev = created.st_dev; value->ino = created.st_ino;
          value->canonical = parent_path + "/" + name;
          stages.push_back(value);
          close(cursor);
          return value;
        }
      }
    }
    int parent = openat(cursor, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent < 0) break;
    struct stat above{};
    if (fstat(parent, &above) != 0) { close(parent); break; }
    if (above.st_dev != target_dev ||
        (above.st_dev == here.st_dev && above.st_ino == here.st_ino)) {
      close(parent); errno = ENOTSUP; break;
    }
    close(cursor);
    cursor = parent;
  }
  int saved = errno ? errno : ENOTSUP;
  close(cursor);
  errno = saved;
  return nullptr;
}

std::shared_ptr<Stage> StageForDevice(int target_parent, dev_t target_dev) {
  std::lock_guard<std::mutex> lock(state_mutex);
  return StageForDeviceLocked(target_parent, target_dev);
}

int RenameNoReplaceAt(int source_parent, const char* source, int target_parent, const char* target) {
#if defined(__APPLE__)
  return renameatx_np(source_parent, source, target_parent, target, RENAME_EXCL);
#elif defined(__linux__) && defined(SYS_renameat2)
  return static_cast<int>(syscall(SYS_renameat2, source_parent, source, target_parent, target, RENAME_NOREPLACE));
#else
  errno = ENOTSUP;
  return -1;
#endif
}

napi_value AtomicWrite(napi_env env, napi_callback_info info) {
  size_t count = 6;
  std::vector<napi_value> args(6);
  if (napi_get_cb_info(env, info, &count, args.data(), nullptr, nullptr) != napi_ok || count < 4)
    return Throw(env, "EINVAL", "native-fs argument missing");
  std::shared_ptr<Root> root;
  std::vector<std::string> parts;
  if (!RootAndPath(env, args, false, &root, &parts)) return nullptr;
  uint8_t* data = nullptr; size_t length = 0; bool overwrite = false;
  if (!GetUint8(env, args[2], &data, &length) || !GetBool(env, args[3], &overwrite))
    return Throw(env, "EINVAL", "invalid atomic write data");
  ExpectedIdentity expected{};
  bool has_expected = count >= 5;
  if (has_expected) {
    napi_value null_value;
    bool is_null = false;
    napi_get_null(env, &null_value);
    napi_strict_equals(env, args[4], null_value, &is_null);
    if (is_null) has_expected = false;
  }
  if (has_expected && !GetExpectedIdentity(env, args[4], &expected))
    return Throw(env, "EINVAL", "invalid expected target identity");
  int32_t creation_mode = 0600;
  if (count >= 6 &&
      (napi_get_value_int32(env, args[5], &creation_mode) != napi_ok ||
       creation_mode < 0 || creation_mode > 0777))
    return Throw(env, "EINVAL", "invalid creation mode");
  int parent = OpenDirectory(*root, parts, parts.size() - 1);
  if (parent < 0) return ThrowErrno(env, "open atomic target parent");
  struct stat parent_st{};
  if (fstat(parent, &parent_st) != 0) {
    int saved = errno; close(parent); return ThrowErrno(env, "stat atomic target parent", saved);
  }
  auto current_stage = StageForDevice(parent, parent_st.st_dev);
  if (!current_stage) {
    int saved = errno; close(parent); return ThrowErrno(env, "find private stage on target filesystem", saved);
  }
  std::string name;
  int source = -1;
  for (int attempt = 0; attempt < 16; ++attempt) {
    if (!RandomName(&name)) { close(parent); return ThrowErrno(env, "generate stage name"); }
    source = openat(current_stage->fd, name.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (source >= 0 || errno != EEXIST) break;
  }
  if (source < 0) { int saved = errno; close(parent); return ThrowErrno(env, "create private stage", saved); }
  bool staged_name_exists = true;
  auto cleanup = [&]() {
    if (source >= 0) close(source);
    if (staged_name_exists) unlinkat(current_stage->fd, name.c_str(), 0);
    close(parent);
  };
  size_t written = 0;
  while (written < length) {
    ssize_t n = write(source, data + written, length - written);
    if (n <= 0) { int saved = n < 0 ? errno : EIO; cleanup(); return ThrowErrno(env, "write private stage", saved); }
    written += static_cast<size_t>(n);
  }
  if (!overwrite && creation_mode != 0600 && fchmod(source, static_cast<mode_t>(creation_mode)) != 0) {
    int saved = errno; cleanup(); return ThrowErrno(env, "set rooted new-file mode", saved);
  }
  if (fsync(source) != 0) { int saved = errno; cleanup(); return ThrowErrno(env, "sync private stage", saved); }
  struct stat opened{}, visible{};
  if (fstat(source, &opened) != 0) {
    int saved = errno; cleanup(); return ThrowErrno(env, "stat private stage handle", saved);
  }
  if (fstatat(current_stage->fd, name.c_str(), &visible, AT_SYMLINK_NOFOLLOW) != 0) {
    int saved = errno; cleanup(); return ThrowErrno(env, "stat private stage name", saved);
  }
  if (!S_ISREG(opened.st_mode) || !S_ISREG(visible.st_mode) ||
      opened.st_dev != visible.st_dev || opened.st_ino != visible.st_ino) {
    cleanup(); return ThrowErrno(env, "private stage identity changed", EIO);
  }
  // Replacing through a private 0600 stage must not silently strip ordinary
  // permission or executable bits from an existing editor target. Special
  // set-id/sticky bits are deliberately not copied. New files remain 0600.
  if (overwrite) {
    struct stat target_mode{};
    if (fstatat(parent, parts.back().c_str(), &target_mode, AT_SYMLINK_NOFOLLOW) == 0) {
      if (S_ISREG(target_mode.st_mode) && fchmod(source, target_mode.st_mode & 0777) != 0) {
        int saved = errno; cleanup(); return ThrowErrno(env, "preserve atomic target mode", saved);
      }
    } else if (errno != ENOENT) {
      int saved = errno; cleanup(); return ThrowErrno(env, "stat atomic target mode", saved);
    }
    if (fsync(source) != 0) {
      int saved = errno; cleanup(); return ThrowErrno(env, "sync private stage mode", saved);
    }
  }
  if (has_expected) {
    struct stat target{};
    if (fstatat(parent, parts.back().c_str(), &target, AT_SYMLINK_NOFOLLOW) != 0 ||
        !SameIdentity(target, expected)) {
      cleanup();
      return Throw(env, "FILE_SOURCE_CHANGED", "atomic target identity changed");
    }
  }
  int commit = 0;
  if (overwrite) {
    commit = renameat(current_stage->fd, name.c_str(), parent, parts.back().c_str());
    if (commit == 0) staged_name_exists = false;
  } else {
    commit = linkat(current_stage->fd, name.c_str(), parent, parts.back().c_str(), 0);
    if (commit == 0) {
      if (unlinkat(current_stage->fd, name.c_str(), 0) != 0) {
        int saved = errno; staged_name_exists = false; cleanup(); return ThrowErrno(env, "consume private stage", saved);
      }
      staged_name_exists = false;
    }
  }
  if (commit != 0) { int saved = errno; cleanup(); return ThrowErrno(env, "commit rooted file", saved); }
  if (fsync(parent) != 0) { int saved = errno; cleanup(); return ThrowErrno(env, "sync rooted parent", saved); }
  cleanup();
  napi_value value; napi_get_undefined(env, &value); return value;
}

napi_value RenameNoReplace(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 3, &args)) return nullptr;
  uint64_t id = 0;
  std::string source_path, target_path;
  if (!GetId(env, args[0], &id) || !GetString(env, args[1], &source_path) ||
      !GetString(env, args[2], &target_path))
    return Throw(env, "EINVAL", "invalid rooted rename arguments");
  auto root = FindRoot(id);
  if (!root) return Throw(env, "NATIVE_ROOT_CLOSED", "root grant is closed");
  std::vector<std::string> source_parts, target_parts;
  if (!SplitRelative(source_path, false, &source_parts) ||
      !SplitRelative(target_path, false, &target_parts))
    return Throw(env, "PATH_DOMAIN_MISMATCH", "relative path contains an invalid component");
  int source_parent = OpenDirectory(*root, source_parts, source_parts.size() - 1);
  if (source_parent < 0) return ThrowErrno(env, "open rename source parent");
  int target_parent = OpenDirectory(*root, target_parts, target_parts.size() - 1);
  if (target_parent < 0) {
    int saved = errno; close(source_parent); return ThrowErrno(env, "open rename target parent", saved);
  }
  if (RenameNoReplaceAt(source_parent, source_parts.back().c_str(), target_parent,
                        target_parts.back().c_str()) != 0) {
    int saved = errno; close(target_parent); close(source_parent);
    return ThrowErrno(env, "rename rooted entry", saved);
  }
  int sync_error = 0;
  if (fsync(source_parent) != 0) sync_error = errno;
  if (target_parent != source_parent && fsync(target_parent) != 0 && !sync_error) sync_error = errno;
  close(target_parent); close(source_parent);
  if (sync_error) return ThrowErrno(env, "sync renamed entry parents", sync_error);
  napi_value value; napi_get_undefined(env, &value); return value;
}

napi_value MoveToStage(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 2, &args)) return nullptr;
  std::shared_ptr<Root> root;
  std::vector<std::string> parts;
  if (!RootAndPath(env, args, false, &root, &parts)) return nullptr;
  int parent = OpenDirectory(*root, parts, parts.size() - 1);
  if (parent < 0) return ThrowErrno(env, "open quarantine source parent");
  struct stat parent_st{};
  if (fstat(parent, &parent_st) != 0) {
    int saved = errno; close(parent); return ThrowErrno(env, "stat quarantine source parent", saved);
  }
  auto current_stage = StageForDevice(parent, parent_st.st_dev);
  if (!current_stage) {
    int saved = errno; close(parent); return ThrowErrno(env, "find private stage on source filesystem", saved);
  }
  struct stat stage_path{};
  if (lstat(current_stage->canonical.c_str(), &stage_path) != 0 ||
      !S_ISDIR(stage_path.st_mode) || stage_path.st_dev != current_stage->dev ||
      stage_path.st_ino != current_stage->ino || stage_path.st_uid != geteuid() ||
      (stage_path.st_mode & 0077) != 0) {
    close(parent); return Throw(env, "EACCES", "private stage pathname no longer names the pinned directory");
  }
  std::string name;
  int moved = -1;
  for (int attempt = 0; attempt < 16; ++attempt) {
    if (!RandomName(&name)) { close(parent); return ThrowErrno(env, "generate quarantine name"); }
    moved = RenameNoReplaceAt(parent, parts.back().c_str(), current_stage->fd, name.c_str());
    if (moved == 0 || errno != EEXIST) break;
  }
  if (moved != 0) {
    int saved = errno; close(parent); return ThrowErrno(env, "quarantine rooted entry", saved);
  }
  int sync_error = 0;
  if (fsync(parent) != 0) sync_error = errno;
  if (fsync(current_stage->fd) != 0 && !sync_error) sync_error = errno;
  close(parent);
  if (sync_error) return ThrowErrno(env, "sync quarantined entry parents", sync_error);
  std::string trusted = current_stage->canonical + "/" + name;
  napi_value result;
  napi_create_string_utf8(env, trusted.c_str(), trusted.size(), &result);
  return result;
}

napi_value BeginQuarantine(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 2, &args)) return nullptr;
  std::shared_ptr<Root> root;
  std::vector<std::string> parts;
  if (!RootAndPath(env, args, false, &root, &parts)) return nullptr;
  int parent = OpenDirectory(*root, parts, parts.size() - 1);
  if (parent < 0) return ThrowErrno(env, "open quarantine source parent");
  struct stat parent_st{};
  if (fstat(parent, &parent_st) != 0) {
    int saved = errno; close(parent); return ThrowErrno(env, "stat quarantine source parent", saved);
  }
  auto current_stage = StageForDevice(parent, parent_st.st_dev);
  if (!current_stage) {
    int saved = errno; close(parent); return ThrowErrno(env, "find private stage on source filesystem", saved);
  }
  struct stat stage_path{};
  if (lstat(current_stage->canonical.c_str(), &stage_path) != 0 ||
      !S_ISDIR(stage_path.st_mode) || stage_path.st_dev != current_stage->dev ||
      stage_path.st_ino != current_stage->ino || stage_path.st_uid != geteuid() ||
      (stage_path.st_mode & 0077) != 0) {
    close(parent); return Throw(env, "EACCES", "private stage pathname no longer names the pinned directory");
  }
  std::string name;
  int moved = -1;
  for (int attempt = 0; attempt < 16; ++attempt) {
    if (!RandomName(&name)) { close(parent); return ThrowErrno(env, "generate quarantine name"); }
    moved = RenameNoReplaceAt(parent, parts.back().c_str(), current_stage->fd, name.c_str());
    if (moved == 0 || errno != EEXIST) break;
  }
  if (moved != 0) {
    int saved = errno; close(parent); return ThrowErrno(env, "quarantine rooted entry", saved);
  }
  auto entry = std::make_shared<Quarantine>();
  entry->parent_fd = parent;
  entry->stage = current_stage;
  entry->staged_name = name;
  entry->original_name = parts.back();
  uint64_t id;
  {
    std::lock_guard<std::mutex> lock(state_mutex);
    id = next_id++;
    quarantines[id] = entry;
  }
  napi_value result, token;
  napi_create_object(env, &result);
  napi_create_bigint_uint64(env, id, &token);
  napi_set_named_property(env, result, "token", token);
  SetString(env, result, "path", current_stage->canonical + "/" + name);
  return result;
}

napi_value RollbackQuarantine(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 1, &args)) return nullptr;
  uint64_t id;
  if (!GetId(env, args[0], &id)) return Throw(env, "EINVAL", "invalid quarantine token");
  auto entry = FindQuarantine(id);
  if (!entry) return Throw(env, "NATIVE_QUARANTINE_CLOSED", "quarantine token is closed");
  if (RenameNoReplaceAt(entry->stage->fd, entry->staged_name.c_str(),
                        entry->parent_fd, entry->original_name.c_str()) != 0)
    return ThrowErrno(env, "restore quarantined entry");
  napi_value value; napi_get_undefined(env, &value); return value;
}

napi_value FinishQuarantine(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 1, &args)) return nullptr;
  uint64_t id;
  if (!GetId(env, args[0], &id)) return Throw(env, "EINVAL", "invalid quarantine token");
  std::lock_guard<std::mutex> lock(state_mutex);
  quarantines.erase(id);
  napi_value value; napi_get_undefined(env, &value); return value;
}

napi_value CopyFileNoReplace(napi_env env, napi_callback_info info) {
  std::vector<napi_value> args;
  if (!Args(env, info, 3, &args)) return nullptr;
  uint64_t id = 0;
  std::string source_path, target_path;
  if (!GetId(env, args[0], &id) || !GetString(env, args[1], &source_path) ||
      !GetString(env, args[2], &target_path))
    return Throw(env, "EINVAL", "invalid rooted copy arguments");
  auto root = FindRoot(id);
  if (!root) return Throw(env, "NATIVE_ROOT_CLOSED", "root grant is closed");
  std::vector<std::string> source_parts, target_parts;
  if (!SplitRelative(source_path, false, &source_parts) ||
      !SplitRelative(target_path, false, &target_parts))
    return Throw(env, "PATH_DOMAIN_MISMATCH", "relative path contains an invalid component");
  int source_parent = OpenDirectory(*root, source_parts, source_parts.size() - 1);
  if (source_parent < 0) return ThrowErrno(env, "open copy source parent");
  int input = openat(source_parent, source_parts.back().c_str(),
                     O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  int saved = errno;
  close(source_parent);
  if (input < 0) return ThrowErrno(env, "open copy source", saved);
  struct stat initial{};
  if (fstat(input, &initial) != 0 || !S_ISREG(initial.st_mode)) {
    saved = errno ? errno : EINVAL; close(input); return ThrowErrno(env, "copy source is not regular", saved);
  }
  Identity source_identity = IdentityOf(initial);
  int target_parent = OpenDirectory(*root, target_parts, target_parts.size() - 1);
  if (target_parent < 0) { saved = errno; close(input); return ThrowErrno(env, "open copy target parent", saved); }
  struct stat target_parent_st{};
  if (fstat(target_parent, &target_parent_st) != 0) {
    saved = errno; close(target_parent); close(input); return ThrowErrno(env, "stat copy target parent", saved);
  }
  auto current_stage = StageForDevice(target_parent, target_parent_st.st_dev);
  if (!current_stage) {
    saved = errno; close(target_parent); close(input);
    return ThrowErrno(env, "find private stage on copy target filesystem", saved);
  }
  std::string name;
  int output = -1;
  for (int attempt = 0; attempt < 16; ++attempt) {
    if (!RandomName(&name)) { close(target_parent); close(input); return ThrowErrno(env, "generate copy stage name"); }
    output = openat(current_stage->fd, name.c_str(),
                    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (output >= 0 || errno != EEXIST) break;
  }
  if (output < 0) {
    saved = errno; close(target_parent); close(input); return ThrowErrno(env, "create copy stage", saved);
  }
  bool staged_name_exists = true;
  auto cleanup = [&]() {
    close(output);
    if (staged_name_exists) unlinkat(current_stage->fd, name.c_str(), 0);
    close(target_parent);
    close(input);
  };
  std::vector<uint8_t> buffer(1024 * 1024);
  off_t offset = 0;
  while (offset < source_identity.size) {
    size_t want = static_cast<size_t>(std::min<off_t>(source_identity.size - offset, buffer.size()));
    ssize_t got = pread(input, buffer.data(), want, offset);
    if (got <= 0) {
      saved = got < 0 ? errno : EIO; cleanup(); return ThrowErrno(env, "read copy source", saved);
    }
    size_t written = 0;
    while (written < static_cast<size_t>(got)) {
      ssize_t count = write(output, buffer.data() + written, static_cast<size_t>(got) - written);
      if (count <= 0) { saved = count < 0 ? errno : EIO; cleanup(); return ThrowErrno(env, "write copy stage", saved); }
      written += static_cast<size_t>(count);
    }
    offset += got;
  }
  struct stat after{}, opened{}, visible{};
  if (fstat(input, &after) != 0 || !SameIdentity(IdentityOf(after), source_identity)) {
    cleanup(); return Throw(env, "FILE_SOURCE_CHANGED", "copy source identity changed");
  }
  if (fchmod(output, initial.st_mode & 0777) != 0) {
    saved = errno; cleanup(); return ThrowErrno(env, "preserve copied file mode", saved);
  }
  if (fsync(output) != 0 || fstat(output, &opened) != 0 ||
      fstatat(current_stage->fd, name.c_str(), &visible, AT_SYMLINK_NOFOLLOW) != 0) {
    saved = errno; cleanup(); return ThrowErrno(env, "verify copy stage", saved);
  }
  if (!S_ISREG(opened.st_mode) || !S_ISREG(visible.st_mode) ||
      opened.st_dev != visible.st_dev || opened.st_ino != visible.st_ino) {
    cleanup(); return ThrowErrno(env, "copy stage identity changed", EIO);
  }
  if (linkat(current_stage->fd, name.c_str(), target_parent, target_parts.back().c_str(), 0) != 0) {
    saved = errno; cleanup(); return ThrowErrno(env, "commit copied file", saved);
  }
  if (unlinkat(current_stage->fd, name.c_str(), 0) != 0) {
    saved = errno; staged_name_exists = false; cleanup(); return ThrowErrno(env, "consume copy stage", saved);
  }
  staged_name_exists = false;
  if (fsync(target_parent) != 0) { saved = errno; cleanup(); return ThrowErrno(env, "sync copied file parent", saved); }
  cleanup();
  napi_value value; napi_get_undefined(env, &value); return value;
}

void Cleanup(void*) {
  std::lock_guard<std::mutex> lock(state_mutex);
  sources.clear(); quarantines.clear(); roots.clear(); stage.reset(); stages.clear();
}

napi_value Init(napi_env env, napi_value exports) {
  struct Method { const char* name; napi_callback callback; } methods[] = {
    {"openRoot", OpenRoot}, {"closeRoot", CloseRoot}, {"stat", Stat}, {"list", List},
    {"mkdirs", Mkdirs}, {"write", Write}, {"writeExpected", WriteExpected},
    {"setMode", SetMode}, {"openSource", OpenSource}, {"openStageSource", OpenStageSource},
    {"readSource", ReadSource}, {"statSource", StatSource}, {"closeSource", CloseSource},
    {"configureStage", ConfigureStage}, {"atomicWrite", AtomicWrite},
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

#endif
