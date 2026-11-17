package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// newline is the separator of messages.jsonl.
const newline = byte(10)

// Files inside one conversation folder.
const (
	sessionStateFile    = "session.json"
	sessionMessagesFile = "messages.jsonl"
	sessionMetaFile     = "meta.json"
)

// SessionSummary is one conversation as the sidebar lists it.
type SessionSummary struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	WorldID   string    `json:"worldId"`
	Messages  int       `json:"messages"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// SessionData is everything the page needs to reopen a conversation.
type SessionData struct {
	Summary  SessionSummary `json:"summary"`
	State    string         `json:"state"`
	Messages []string       `json:"messages"`
}

// sessionMeta is the index the host keeps beside a transcript: it carries the
// creation time the page does not mirror and the line count, so listing
// conversations never has to read whole transcripts.
type sessionMeta struct {
	Title     string    `json:"title"`
	WorldID   string    `json:"worldId"`
	Messages  int       `json:"messages"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Sessions stores conversations. session.json holds the mutable state the
// page defines (world, memory, overlay, world info timers); messages.jsonl
// holds one raw JSON message per line, so appending a turn never rewrites the
// transcript.
type Sessions struct{}

// List returns every conversation, most recently updated first.
func (Sessions) List() ([]SessionSummary, error) {
	root, err := appDir("sessions")
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, publicError(err)
	}
	list := make([]SessionSummary, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		summary, err := loadSessionSummary(entry.Name())
		if err != nil {
			// One unreadable folder must not break the whole list; the log keeps
			// the reason findable.
			log.Printf("sessions: skipping %q: %v", entry.Name(), err)
			continue
		}
		list = append(list, summary)
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].UpdatedAt.After(list[j].UpdatedAt)
	})
	return list, nil
}

// Create starts an empty conversation and returns its summary.
func (Sessions) Create(worldID string, title string) (SessionSummary, error) {
	root, err := appDir("sessions")
	if err != nil {
		return SessionSummary{}, err
	}
	cleanTitle := strings.TrimSpace(title)
	if cleanTitle == "" {
		cleanTitle = "未命名会话"
	}
	now := time.Now()
	stamp := now.Format("20060102-150405")
	for attempt := 0; attempt < 8; attempt++ {
		suffix, err := randomHex(8)
		if err != nil {
			return SessionSummary{}, err
		}
		id := "s-" + stamp + "-" + suffix
		dir := filepath.Join(root, id)
		// Mkdir is the atomic claim on the id: a collision fails instead of
		// overwriting another conversation's state and transcript.
		if err := os.Mkdir(dir, dirPerm); err != nil {
			if errors.Is(err, fs.ErrExist) {
				continue
			}
			return SessionSummary{}, publicError(err)
		}
		if err := writeNewSession(dir, id, cleanTitle, strings.TrimSpace(worldID), now); err != nil {
			_ = os.RemoveAll(dir)
			return SessionSummary{}, err
		}
		return loadSessionSummary(id)
	}
	return SessionSummary{}, errors.New("无法创建会话：标识冲突")
}

// writeNewSession fills a freshly created conversation folder.
func writeNewSession(dir string, id string, title string, worldID string, now time.Time) error {
	state := map[string]any{
		"id":        id,
		"title":     title,
		"worldId":   worldID,
		"createdAt": now.Format(time.RFC3339Nano),
		"updatedAt": now.Format(time.RFC3339Nano),
		"messages":  0,
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(dir, sessionStateFile), data, filePerm); err != nil {
		return publicError(err)
	}
	if err := writeFileAtomic(filepath.Join(dir, sessionMessagesFile), nil, filePerm); err != nil {
		return publicError(err)
	}
	return writeSessionMeta(dir, sessionMeta{
		Title:     title,
		WorldID:   worldID,
		Messages:  0,
		CreatedAt: now,
		UpdatedAt: now,
	})
}

// Load returns a conversation's state and transcript.
func (Sessions) Load(id string) (SessionData, error) {
	cleanID, err := validID(id)
	if err != nil {
		return SessionData{}, err
	}
	dir, err := sessionPath(cleanID)
	if err != nil {
		return SessionData{}, err
	}
	state, err := readLimited(filepath.Join(dir, sessionStateFile), maxSessionBytes)
	if errors.Is(err, fs.ErrNotExist) {
		return SessionData{}, sessionNotFound(cleanID)
	}
	if err != nil {
		return SessionData{}, fmt.Errorf("会话状态读取失败：%w", publicError(err))
	}
	summary, err := loadSessionSummary(cleanID)
	if err != nil {
		return SessionData{}, err
	}
	messages, err := readTranscript(dir)
	if err != nil {
		return SessionData{}, err
	}
	return SessionData{Summary: summary, State: string(state), Messages: messages}, nil
}

// readTranscript returns the transcript lines. A missing file is an empty
// transcript; any other failure is reported, so the page never shows a
// conversation whose count and content disagree.
func readTranscript(dir string) ([]string, error) {
	data, err := readLimited(filepath.Join(dir, sessionMessagesFile), maxSessionBytes)
	if errors.Is(err, fs.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("会话转录读取失败：%w", publicError(err))
	}
	messages := make([]string, 0, 64)
	for _, line := range strings.Split(string(data), string(newline)) {
		line = strings.TrimSpace(line)
		if line != "" {
			messages = append(messages, line)
		}
	}
	return messages, nil
}

// SaveState replaces session.json with the page's current state.
func (Sessions) SaveState(id string, raw string) (SessionSummary, error) {
	cleanID, err := validID(id)
	if err != nil {
		return SessionSummary{}, err
	}
	clean, err := decodeJSONObject(raw, maxSessionBytes)
	if err != nil {
		return SessionSummary{}, err
	}
	if err := checkSessionIdentity(clean, cleanID); err != nil {
		return SessionSummary{}, err
	}
	dir, err := sessionPath(cleanID)
	if err != nil {
		return SessionSummary{}, err
	}
	statePath := filepath.Join(dir, sessionStateFile)
	if _, err := os.Stat(statePath); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return SessionSummary{}, sessionNotFound(cleanID)
		}
		return SessionSummary{}, publicError(err)
	}
	unlock := lockPath(statePath)
	err = writeFileAtomic(statePath, clean, filePerm)
	unlock()
	if err != nil {
		return SessionSummary{}, fmt.Errorf("保存会话失败：%w", publicError(err))
	}
	title, worldID, created, updated := sessionStateHeader(clean)
	touchSessionMeta(dir, func(meta *sessionMeta, _ bool) {
		if title != "" {
			meta.Title = title
		}
		if worldID != "" {
			meta.WorldID = worldID
		}
		if !created.IsZero() && meta.CreatedAt.IsZero() {
			meta.CreatedAt = created
		}
		meta.UpdatedAt = time.Now()
		if updated.After(meta.UpdatedAt) {
			meta.UpdatedAt = updated
		}
	})
	return loadSessionSummary(cleanID)
}

// AppendMessage adds one message line to the transcript.
func (Sessions) AppendMessage(id string, raw string) error {
	cleanID, err := validID(id)
	if err != nil {
		return err
	}
	clean, err := decodeJSONObject(raw, maxMessageBytes)
	if err != nil {
		return err
	}
	dir, err := sessionPath(cleanID)
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(dir, sessionStateFile)); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return sessionNotFound(cleanID)
		}
		return publicError(err)
	}
	path := filepath.Join(dir, sessionMessagesFile)
	// The lock keeps this append on the same inode ReplaceMessages leaves
	// behind, so a rewind never swallows the turn that follows it.
	unlock := lockPath(path)
	defer unlock()
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, filePerm)
	if err != nil {
		return publicError(err)
	}
	if _, err := file.Write(append(clean, newline)); err != nil {
		_ = file.Close()
		return publicError(err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return publicError(err)
	}
	if err := file.Close(); err != nil {
		return publicError(err)
	}
	touchSessionMeta(dir, func(meta *sessionMeta, rebuilt bool) {
		// A rebuilt index already counted the line that was just written.
		if !rebuilt {
			meta.Messages++
		}
		meta.UpdatedAt = time.Now()
	})
	return nil
}

// ReplaceMessages rewrites the whole transcript, for edits and rewinds.
func (Sessions) ReplaceMessages(id string, messages []string) (SessionSummary, error) {
	cleanID, err := validID(id)
	if err != nil {
		return SessionSummary{}, err
	}
	var builder strings.Builder
	count := 0
	for i, line := range messages {
		clean, err := decodeJSONObject(line, maxMessageBytes)
		if err != nil {
			return SessionSummary{}, fmt.Errorf("第 %d 条消息无效：%w", i+1, err)
		}
		builder.Write(clean)
		builder.WriteByte(newline)
		count++
	}
	dir, err := sessionPath(cleanID)
	if err != nil {
		return SessionSummary{}, err
	}
	if _, err := os.Stat(filepath.Join(dir, sessionStateFile)); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return SessionSummary{}, sessionNotFound(cleanID)
		}
		return SessionSummary{}, publicError(err)
	}
	path := filepath.Join(dir, sessionMessagesFile)
	unlock := lockPath(path)
	err = writeFileAtomic(path, []byte(builder.String()), filePerm)
	unlock()
	if err != nil {
		return SessionSummary{}, fmt.Errorf("重写会话转录失败：%w", publicError(err))
	}
	touchSessionMeta(dir, func(meta *sessionMeta, _ bool) {
		meta.Messages = count
		meta.UpdatedAt = time.Now()
	})
	return loadSessionSummary(cleanID)
}

// Delete moves a conversation to the app's Trash folder.
func (Sessions) Delete(id string) error {
	cleanID, err := validID(id)
	if err != nil {
		return err
	}
	dir, err := sessionPath(cleanID)
	if err != nil {
		return err
	}
	if _, err := os.Stat(dir); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return sessionNotFound(cleanID)
		}
		return publicError(err)
	}
	if err := moveToTrash(dir); err != nil {
		if errors.Is(err, errNotExist) {
			return sessionNotFound(cleanID)
		}
		return publicError(err)
	}
	return nil
}

// sessionNotFound builds the message the page recognises as "no such session".
func sessionNotFound(id string) error {
	return fmt.Errorf("找不到会话：%s", id)
}

// sessionPath resolves a validated id without creating anything, so reading
// an unknown id leaves no empty folder behind.
func sessionPath(id string) (string, error) {
	clean, err := validID(id)
	if err != nil {
		return "", err
	}
	root, err := userDataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "sessions", clean), nil
}

// loadSessionSummary reads the index. Only a conversation without one is read
// from its state file, and that read refills the index for the next call.
func loadSessionSummary(id string) (SessionSummary, error) {
	cleanID, err := validID(id)
	if err != nil {
		return SessionSummary{}, err
	}
	dir, err := sessionPath(cleanID)
	if err != nil {
		return SessionSummary{}, err
	}
	statePath := filepath.Join(dir, sessionStateFile)
	messagePath := filepath.Join(dir, sessionMessagesFile)
	if meta, ok := readSessionMeta(dir); ok {
		info, err := os.Stat(statePath)
		if errors.Is(err, fs.ErrNotExist) {
			return SessionSummary{}, sessionNotFound(cleanID)
		}
		if err != nil {
			return SessionSummary{}, publicError(err)
		}
		if meta.CreatedAt.IsZero() {
			meta.CreatedAt = info.ModTime()
		}
		if meta.UpdatedAt.IsZero() {
			meta.UpdatedAt = info.ModTime()
		}
		if messageInfo, statErr := os.Stat(messagePath); statErr == nil {
			if messageInfo.ModTime().After(meta.UpdatedAt) {
				meta.UpdatedAt = messageInfo.ModTime()
			}
		}
		return summaryFromMeta(cleanID, meta), nil
	}
	state, err := readLimited(statePath, maxSessionBytes)
	if errors.Is(err, fs.ErrNotExist) {
		return SessionSummary{}, sessionNotFound(cleanID)
	}
	if err != nil {
		return SessionSummary{}, fmt.Errorf("会话状态读取失败：%w", publicError(err))
	}
	info, err := os.Stat(statePath)
	if err != nil {
		return SessionSummary{}, publicError(err)
	}
	meta := sessionMeta{CreatedAt: info.ModTime(), UpdatedAt: info.ModTime()}
	meta.Title, meta.WorldID, meta.CreatedAt, meta.UpdatedAt = sessionStateHeader(state)
	if meta.CreatedAt.IsZero() {
		meta.CreatedAt = info.ModTime()
	}
	if meta.UpdatedAt.IsZero() {
		meta.UpdatedAt = info.ModTime()
	}
	meta.Messages = countTranscript(messagePath)
	if err := writeSessionMeta(dir, meta); err != nil {
		log.Printf("sessions: installing the index for %s failed: %v", dir, err)
	}
	return summaryFromMeta(cleanID, meta), nil
}

// summaryFromMeta builds the sidebar row from one index entry.
func summaryFromMeta(id string, meta sessionMeta) SessionSummary {
	title := strings.TrimSpace(meta.Title)
	if title == "" {
		title = "未命名会话"
	}
	return SessionSummary{
		ID:        id,
		Title:     title,
		WorldID:   strings.TrimSpace(meta.WorldID),
		Messages:  meta.Messages,
		CreatedAt: meta.CreatedAt,
		UpdatedAt: meta.UpdatedAt,
	}
}

// sessionStateHeader reads the metadata the page mirrors at the top level of
// session.json. Timestamps may be RFC 3339 text or epoch numbers, and a state
// file this build cannot parse simply contributes none of them.
func sessionStateHeader(state []byte) (title string, worldID string, created time.Time, updated time.Time) {
	var probe struct {
		Title     json.RawMessage `json:"title"`
		WorldID   json.RawMessage `json:"worldId"`
		CreatedAt json.RawMessage `json:"createdAt"`
		UpdatedAt json.RawMessage `json:"updatedAt"`
	}
	if err := json.Unmarshal(state, &probe); err != nil {
		log.Printf("sessions: reading the state header failed: %v", err)
		return "", "", time.Time{}, time.Time{}
	}
	return strings.TrimSpace(jsonString(probe.Title)),
		strings.TrimSpace(jsonString(probe.WorldID)),
		parseMetaTimeRaw(probe.CreatedAt, time.Time{}),
		parseMetaTimeRaw(probe.UpdatedAt, time.Time{})
}

// checkSessionIdentity rejects a state file whose own id disagrees with the
// folder it would be written to; that mismatch is how duplicate or orphaned
// conversations appear.
func checkSessionIdentity(state []byte, id string) error {
	var probe struct {
		ID   json.RawMessage `json:"id"`
		Meta json.RawMessage `json:"meta"`
	}
	if err := json.Unmarshal(state, &probe); err != nil {
		return nil
	}
	candidates := []string{jsonString(probe.ID), jsonString(jsonObject(probe.Meta)["id"])}
	for _, candidate := range candidates {
		inner := strings.TrimSpace(candidate)
		if inner == "" || !idPattern.MatchString(inner) || inner == id {
			continue
		}
		return fmt.Errorf("会话标识不一致：状态文件属于 %s", inner)
	}
	return nil
}

// readSessionMeta reads the sidecar index, reporting false when it is missing
// or unreadable.
func readSessionMeta(dir string) (sessionMeta, bool) {
	data, err := readLimited(filepath.Join(dir, sessionMetaFile), maxSidecarBytes)
	if err != nil {
		return sessionMeta{}, false
	}
	var meta sessionMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return sessionMeta{}, false
	}
	return meta, true
}

// writeSessionMeta stores the sidecar index.
func writeSessionMeta(dir string, meta sessionMeta) error {
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(dir, sessionMetaFile), data, filePerm); err != nil {
		return publicError(err)
	}
	return nil
}

// touchSessionMeta applies a change to the index, rebuilding it first when the
// sidecar is missing. mutate learns whether it ran on a fresh rebuild, because a
// rebuild already read the files the change would count. A failed write only
// costs the next listing a rebuild.
func touchSessionMeta(dir string, mutate func(meta *sessionMeta, rebuilt bool)) {
	meta, ok := readSessionMeta(dir)
	rebuilt := !ok
	if rebuilt {
		meta = rebuildSessionMeta(dir)
	}
	mutate(&meta, rebuilt)
	if err := writeSessionMeta(dir, meta); err != nil {
		log.Printf("sessions: writing the index for %s failed: %v", dir, err)
	}
}

// rebuildSessionMeta builds the index from the files on disk.
func rebuildSessionMeta(dir string) sessionMeta {
	meta := sessionMeta{UpdatedAt: time.Now()}
	statePath := filepath.Join(dir, sessionStateFile)
	if info, err := os.Stat(statePath); err == nil {
		meta.CreatedAt = info.ModTime()
		meta.UpdatedAt = info.ModTime()
	}
	if state, err := readLimited(statePath, maxSessionBytes); err == nil {
		title, worldID, created, updated := sessionStateHeader(state)
		meta.Title = title
		meta.WorldID = worldID
		if !created.IsZero() {
			meta.CreatedAt = created
		}
		if !updated.IsZero() {
			meta.UpdatedAt = updated
		}
	}
	meta.Messages = countTranscript(filepath.Join(dir, sessionMessagesFile))
	return meta
}

// countTranscript counts the non-empty transcript lines without loading the
// whole file into memory.
func countTranscript(path string) int {
	file, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer func() { _ = file.Close() }()
	reader := bufio.NewReaderSize(file, 64<<10)
	count := 0
	for {
		line, err := reader.ReadBytes(newline)
		if len(bytes.TrimSpace(line)) > 0 {
			count++
		}
		if err != nil {
			break
		}
	}
	return count
}
