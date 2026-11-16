package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// newline is the separator of messages.jsonl.
const newline = byte(10)

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
		return nil, err
	}
	list := make([]SessionSummary, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		summary, err := loadSessionSummary(entry.Name())
		if err != nil {
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
	id := "s-" + time.Now().Format("20060102-150405") + "-" + randomHex(4)
	dir, err := sessionDir(id)
	if err != nil {
		return SessionSummary{}, err
	}
	cleanTitle := strings.TrimSpace(title)
	if cleanTitle == "" {
		cleanTitle = "未命名会话"
	}
	now := time.Now()
	state := map[string]any{
		"id":        id,
		"title":     cleanTitle,
		"worldId":   strings.TrimSpace(worldID),
		"createdAt": now.Format(time.RFC3339Nano),
		"updatedAt": now.Format(time.RFC3339Nano),
		"messages":  0,
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return SessionSummary{}, err
	}
	if err := writeFileAtomic(filepath.Join(dir, "session.json"), data, filePerm); err != nil {
		return SessionSummary{}, err
	}
	if err := os.WriteFile(filepath.Join(dir, "messages.jsonl"), nil, filePerm); err != nil {
		return SessionSummary{}, err
	}
	return loadSessionSummary(id)
}

// Load returns a conversation's state and transcript.
func (Sessions) Load(id string) (SessionData, error) {
	statePath, err := sessionStatePath(id)
	if err != nil {
		return SessionData{}, err
	}
	state, err := readLimited(statePath, maxArtifactBytes)
	if errors.Is(err, os.ErrNotExist) {
		return SessionData{}, fmt.Errorf("找不到会话：%s", id)
	}
	if err != nil {
		return SessionData{}, err
	}
	summary, err := loadSessionSummary(id)
	if err != nil {
		return SessionData{}, err
	}
	messages := make([]string, 0, summary.Messages)
	if messagePath, pathErr := sessionMessagesPath(id); pathErr == nil {
		if data, readErr := readLimited(messagePath, maxSessionBytes); readErr == nil {
			for _, line := range strings.Split(string(data), string(newline)) {
				line = strings.TrimSpace(line)
				if line != "" {
					messages = append(messages, line)
				}
			}
		}
	}
	return SessionData{Summary: summary, State: string(state), Messages: messages}, nil
}

// SaveState replaces session.json with the page's current state.
func (Sessions) SaveState(id string, raw string) (SessionSummary, error) {
	clean, err := decodeJSONObject(raw, maxArtifactBytes)
	if err != nil {
		return SessionSummary{}, err
	}
	path, err := sessionStatePath(id)
	if err != nil {
		return SessionSummary{}, err
	}
	if err := writeFileAtomic(path, clean, filePerm); err != nil {
		return SessionSummary{}, err
	}
	return loadSessionSummary(id)
}

// AppendMessage adds one message line to the transcript.
func (Sessions) AppendMessage(id string, raw string) error {
	clean, err := decodeJSONObject(raw, maxMessageBytes)
	if err != nil {
		return err
	}
	dir, err := sessionDir(id)
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(dir, "session.json")); errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("找不到会话：%s", id)
	}
	path := filepath.Join(dir, "messages.jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, filePerm)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	if _, err := file.Write(append(clean, newline)); err != nil {
		return err
	}
	return file.Sync()
}

// ReplaceMessages rewrites the whole transcript, for edits and rewinds.
func (Sessions) ReplaceMessages(id string, messages []string) (SessionSummary, error) {
	var builder strings.Builder
	for i, line := range messages {
		clean, err := decodeJSONObject(line, maxMessageBytes)
		if err != nil {
			return SessionSummary{}, fmt.Errorf("第 %d 条消息无效：%w", i+1, err)
		}
		builder.Write(clean)
		builder.WriteByte(newline)
	}
	path, err := sessionMessagesPath(id)
	if err != nil {
		return SessionSummary{}, err
	}
	if err := writeFileAtomic(path, []byte(builder.String()), filePerm); err != nil {
		return SessionSummary{}, err
	}
	return loadSessionSummary(id)
}

// Delete moves a conversation to the app's Trash folder.
func (Sessions) Delete(id string) error {
	dir, err := sessionDir(id)
	if err != nil {
		return err
	}
	return moveToTrash(dir)
}

// sessionDir resolves a validated id to its folder, creating it.
func sessionDir(id string) (string, error) {
	clean, err := validID(id)
	if err != nil {
		return "", err
	}
	return appDir("sessions", clean)
}

// sessionStatePath is the session.json of one conversation.
func sessionStatePath(id string) (string, error) {
	dir, err := sessionDir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "session.json"), nil
}

// sessionMessagesPath is the messages.jsonl of one conversation.
func sessionMessagesPath(id string) (string, error) {
	dir, err := sessionDir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "messages.jsonl"), nil
}

// loadSessionSummary reads the metadata and counts the transcript lines.
func loadSessionSummary(id string) (SessionSummary, error) {
	statePath, err := sessionStatePath(id)
	if err != nil {
		return SessionSummary{}, err
	}
	state, err := readLimited(statePath, maxArtifactBytes)
	if err != nil {
		return SessionSummary{}, err
	}
	var meta struct {
		Title     string `json:"title"`
		WorldID   string `json:"worldId"`
		CreatedAt string `json:"createdAt"`
		UpdatedAt string `json:"updatedAt"`
	}
	_ = json.Unmarshal(state, &meta)
	info, err := os.Stat(statePath)
	if err != nil {
		return SessionSummary{}, err
	}
	created := parseMetaTime(meta.CreatedAt, info.ModTime())
	updated := parseMetaTime(meta.UpdatedAt, info.ModTime())
	count := 0
	if messagePath, pathErr := sessionMessagesPath(id); pathErr == nil {
		if messageInfo, statErr := os.Stat(messagePath); statErr == nil {
			if messageInfo.ModTime().After(updated) {
				updated = messageInfo.ModTime()
			}
			if data, readErr := readLimited(messagePath, maxSessionBytes); readErr == nil {
				count = countMessageLines(data)
			}
		}
	}
	title := strings.TrimSpace(meta.Title)
	if title == "" {
		title = "未命名会话"
	}
	return SessionSummary{
		ID:        id,
		Title:     title,
		WorldID:   strings.TrimSpace(meta.WorldID),
		Messages:  count,
		CreatedAt: created,
		UpdatedAt: updated,
	}, nil
}

// countMessageLines counts the non-empty lines of a messages.jsonl file.
func countMessageLines(data []byte) int {
	count := 0
	for _, line := range strings.Split(string(data), string(newline)) {
		if strings.TrimSpace(line) != "" {
			count++
		}
	}
	return count
}
