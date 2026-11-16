package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
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
)

// bomPrefix starts a UTF-8 text file some editors add.
var bomPrefix = []byte{0xef, 0xbb, 0xbf}

// idPattern keeps an identifier safe to join onto a path.
var idPattern = regexp.MustCompile("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

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
		return "", err
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

// randomHex returns n lowercase hex characters.
func randomHex(n int) string {
	buf := make([]byte, (n+1)/2)
	if _, err := rand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)[:n]
	}
	return hex.EncodeToString(buf)[:n]
}

// generatedID builds a path-safe identifier with a random suffix.
func generatedID(prefix string) string {
	return prefix + "-" + randomHex(8)
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
	return os.Rename(name, path)
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
		return nil, fmt.Errorf("文件过大：%d 字节，上限 %d", info.Size(), max)
	}
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("文件过大，上限 %d 字节", max)
	}
	return data, nil
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
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	trashDir, err := appDir("Trash")
	if err != nil {
		return err
	}
	stamp := time.Now().Format("20060102-150405")
	target := filepath.Join(trashDir, filepath.Base(path)+"-"+stamp)
	for i := 1; ; i++ {
		if _, err := os.Stat(target); errors.Is(err, os.ErrNotExist) {
			break
		}
		target = filepath.Join(trashDir, fmt.Sprintf("%s-%s-%d", filepath.Base(path), stamp, i))
	}
	return os.Rename(path, target)
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
		if n > 1e12 {
			return time.UnixMilli(n)
		}
		return time.Unix(n, 0)
	}
	return fallback
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
