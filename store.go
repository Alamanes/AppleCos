package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// Everything the app writes is private: transcripts and character cards stay
// readable by the user alone.
const (
	dirPerm  = 0o700
	filePerm = 0o600
)

// Size caps for values that reach the store from the page or from disk.
const (
	maxArtifactBytes = 8 << 20
	maxImportBytes   = 64 << 20
	maxMessageBytes  = 4 << 20
	maxSessionBytes  = 64 << 20
	maxConfigBytes   = 1 << 20
	// maxSidecarBytes covers the small host-maintained index files.
	maxSidecarBytes = 64 << 10
)

// Trash retention keeps deletions recoverable without growing forever.
const (
	trashRetention = 30 * 24 * time.Hour
	trashMaxBytes  = 512 << 20
)

// bomPrefix starts a UTF-8 text file some editors add.
var bomPrefix = []byte{0xef, 0xbb, 0xbf}

// idPattern keeps an identifier safe to join onto a path.
var idPattern = regexp.MustCompile("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

// errNotExist marks a lookup of something that is not on disk.
var errNotExist = errors.New("内容不存在")

// errTooLarge marks a file above its size cap.
var errTooLarge = errors.New("文件过大")

// userDataDir is the app's data directory, created on first use.
func userDataDir() (string, error) {
	return mygo.App.Path(mygo.PathUserData)
}

// appDir joins parts onto the data directory and creates the result.
func appDir(parts ...string) (string, error) {
	root, err := userDataDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(append([]string{root}, parts...)...)
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return "", publicError(err)
	}
	return dir, nil
}

// validID trims an identifier and rejects anything a path could escape with.
func validID(id string) (string, error) {
	trimmed := strings.TrimSpace(id)
	if !idPattern.MatchString(trimmed) {
		return "", fmt.Errorf("标识不合法：%q", id)
	}
	return trimmed, nil
}

// randomHex returns n lowercase hex characters. It reports failure instead of
// falling back to a predictable value, because ids are built from it.
func randomHex(n int) (string, error) {
	buf := make([]byte, (n+1)/2)
	if _, err := rand.Read(buf); err != nil {
		return "", errors.New("无法生成随机标识")
	}
	return hex.EncodeToString(buf)[:n], nil
}

// generatedID builds a path-safe identifier with a random suffix.
func generatedID(prefix string) (string, error) {
	suffix, err := randomHex(8)
	if err != nil {
		return "", err
	}
	return prefix + "-" + suffix, nil
}

// pathLocks serializes writers of one file, so an append never races the
// atomic rewrite that replaces the same path.
var pathLocks struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

// lockPath returns the unlock function for one file's write lock.
func lockPath(path string) func() {
	key := filepath.Clean(path)
	pathLocks.mu.Lock()
	if pathLocks.locks == nil {
		pathLocks.locks = make(map[string]*sync.Mutex)
	}
	mu, ok := pathLocks.locks[key]
	if !ok {
		mu = &sync.Mutex{}
		pathLocks.locks[key] = mu
	}
	pathLocks.mu.Unlock()
	mu.Lock()
	return mu.Unlock
}

// writeFileAtomic replaces path with data through a temporary sibling, so a
// crash never leaves a half-written file behind.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	// The rename itself must reach the disk, or a crash can roll the entry back.
	syncDir(dir)
	return nil
}

// syncDir flushes a directory entry, ignoring the platforms that refuse it.
func syncDir(dir string) {
	handle, err := os.Open(dir)
	if err != nil {
		return
	}
	defer func() { _ = handle.Close() }()
	if err := handle.Sync(); err != nil && !errors.Is(err, fs.ErrInvalid) {
		log.Printf("store: syncing %s failed: %v", dir, err)
	}
}

// readLimited reads a file, refusing anything larger than max bytes.
func readLimited(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > max {
		return nil, fmt.Errorf("%w：%d 字节，上限 %d", errTooLarge, info.Size(), max)
	}
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("%w，上限 %d 字节", errTooLarge, max)
	}
	return data, nil
}

// publicError turns a filesystem error into a message the page may show: the
// details, including absolute paths, stay in the log.
func publicError(err error) error {
	if err == nil {
		return nil
	}
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		log.Printf("store: %v", err)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return errNotExist
		case errors.Is(err, fs.ErrPermission):
			return errors.New("没有访问该文件的权限")
		case errors.Is(err, fs.ErrExist):
			return errors.New("文件已存在")
		}
		return errors.New("文件操作失败")
	}
	return err
}

// decodeJSONObject validates raw as a JSON object and returns it trimmed.
func decodeJSONObject(raw string, max int) ([]byte, error) {
	trimmed := strings.TrimSpace(string(bytes.TrimPrefix([]byte(raw), bomPrefix)))
	if trimmed == "" {
		return nil, errors.New("JSON 内容为空")
	}
	if len(trimmed) > max {
		return nil, fmt.Errorf("JSON 太大：%d 字节，上限 %d", len(trimmed), max)
	}
	if !strings.HasPrefix(trimmed, "{") {
		return nil, errors.New("需要一个 JSON 对象")
	}
	if !json.Valid([]byte(trimmed)) {
		return nil, errors.New("不是合法的 JSON")
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &probe); err != nil {
		return nil, errors.New("需要一个 JSON 对象")
	}
	return []byte(trimmed), nil
}

// moveToTrash moves a file or directory into the app's Trash folder. Deleting
// through it keeps a bad import or a misclicked session recoverable.
func moveToTrash(path string) error {
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return errNotExist
		}
		return publicError(err)
	}
	trashDir, err := appDir("Trash")
	if err != nil {
		return err
	}
	stamp := time.Now().Format("20060102-150405")
	target := filepath.Join(trashDir, filepath.Base(path)+"-"+stamp)
	for i := 1; ; i++ {
		if _, err := os.Stat(target); errors.Is(err, fs.ErrNotExist) {
			break
		}
		target = filepath.Join(trashDir, fmt.Sprintf("%s-%s-%d", filepath.Base(path), stamp, i))
	}
	if err := os.Rename(path, target); err != nil {
		return err
	}
	return nil
}

// pruneTrash drops deletions older than the retention window and keeps the
// folder under its size cap, oldest first. It runs once at startup.
func pruneTrash() {
	trashDir, err := appDir("Trash")
	if err != nil {
		log.Printf("store: trash is unavailable: %v", err)
		return
	}
	entries, err := os.ReadDir(trashDir)
	if err != nil {
		log.Printf("store: listing trash failed: %v", err)
		return
	}
	type item struct {
		name  string
		size  int64
		mtime time.Time
	}
	items := make([]item, 0, len(entries))
	var total int64
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		size := dirSize(filepath.Join(trashDir, entry.Name()))
		total += size
		items = append(items, item{name: entry.Name(), size: size, mtime: info.ModTime()})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].mtime.Before(items[j].mtime) })
	cutoff := time.Now().Add(-trashRetention)
	for _, it := range items {
		if !it.mtime.Before(cutoff) && total <= trashMaxBytes {
			continue
		}
		if err := os.RemoveAll(filepath.Join(trashDir, it.name)); err != nil {
			log.Printf("store: pruning trash entry failed: %v", err)
			continue
		}
		total -= it.size
	}
}

// dirSize totals the bytes under one path.
func dirSize(path string) int64 {
	var total int64
	_ = filepath.WalkDir(path, func(_ string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if info, err := entry.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

// parseMetaTime reads a timestamp written as RFC 3339 text or as epoch
// seconds/milliseconds. fallback is returned when the value cannot be read.
func parseMetaTime(raw string, fallback time.Time) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return t
	}
	if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
		return parseEpochTime(float64(n), fallback)
	}
	if n, err := strconv.ParseFloat(raw, 64); err == nil {
		return parseEpochTime(n, fallback)
	}
	return fallback
}

// parseMetaTimeRaw reads a timestamp member written either as text or as a
// number, so a page that mirrors epoch milliseconds keeps working.
func parseMetaTimeRaw(raw json.RawMessage, fallback time.Time) time.Time {
	if len(raw) == 0 {
		return fallback
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return parseMetaTime(text, fallback)
	}
	var number float64
	if json.Unmarshal(raw, &number) == nil {
		return parseEpochTime(number, fallback)
	}
	return fallback
}

// parseEpochTime reads epoch seconds or milliseconds.
func parseEpochTime(n float64, fallback time.Time) time.Time {
	switch {
	case n <= 0:
		return fallback
	case n > 1e11:
		return time.UnixMilli(int64(n))
	default:
		return time.Unix(int64(n), 0)
	}
}

// jsonString reads a string member, or the empty string when it is missing.
func jsonString(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
}

// jsonObject reads an object member, or nil when it is missing.
func jsonObject(raw json.RawMessage) map[string]json.RawMessage {
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) == nil {
		return obj
	}
	return nil
}

// resolveInside joins a page-supplied relative name onto root and refuses
// anything that would leave it.
func resolveInside(root string, rel string) (string, error) {
	name := strings.TrimSpace(rel)
	if name == "" {
		return "", errors.New("没有指定文件")
	}
	if strings.HasPrefix(name, "~") || filepath.IsAbs(name) || strings.ContainsRune(name, 0) {
		return "", errors.New("只接受数据目录内的相对路径")
	}
	clean := filepath.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("路径不能跳出数据目录")
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	targetAbs, err := filepath.Abs(filepath.Join(rootAbs, clean))
	if err != nil {
		return "", err
	}
	inside, err := filepath.Rel(rootAbs, targetAbs)
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return "", errors.New("路径不能跳出数据目录")
	}
	return targetAbs, nil
}
