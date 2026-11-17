package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// Artifact is one entry in the library: a world, a character card or a
// lorebook. Contents stay raw JSON, because the page owns their schema.
type Artifact struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Kind      string    `json:"kind"`
	Detail    string    `json:"detail,omitempty"`
	Bytes     int64     `json:"bytes"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// artifactKind names one library folder and the label the page sees.
type artifactKind struct {
	folder string
	label  string
}

var (
	worldKind    = artifactKind{folder: "worlds", label: "world"}
	cardKind     = artifactKind{folder: "cards", label: "card"}
	lorebookKind = artifactKind{folder: "lorebooks", label: "lorebook"}
)

// Library stores worlds, character cards and lorebooks in the app's data
// directory. Every method takes or returns raw JSON strings, so the page can
// change its schema without touching this file.
type Library struct{}

// ListWorlds returns the worlds on disk, newest first.
func (Library) ListWorlds() ([]Artifact, error) { return listArtifacts(worldKind) }

// LoadWorld returns one world's JSON.
func (Library) LoadWorld(id string) (string, error) { return loadArtifact(worldKind, id) }

// SaveWorld writes a world and returns the id it was stored under. An empty
// id derives one from the JSON, or generates a fresh one.
func (Library) SaveWorld(id string, raw string) (string, error) {
	return saveArtifact(worldKind, id, raw)
}

// DeleteWorld moves a world to the app's Trash folder.
func (Library) DeleteWorld(id string) error { return deleteArtifact(worldKind, id) }

// ListCards returns the character cards on disk, newest first.
func (Library) ListCards() ([]Artifact, error) { return listArtifacts(cardKind) }

// LoadCard returns one card's JSON, always in the V3 shape.
func (Library) LoadCard(id string) (string, error) { return loadArtifact(cardKind, id) }

// SaveCard normalizes a card to V3, writes it, and returns its id.
func (Library) SaveCard(id string, raw string) (string, error) {
	clean, err := decodeJSONObject(raw, maxArtifactBytes)
	if err != nil {
		return "", err
	}
	normalized, summary, err := normalizeCard(clean, "json")
	if err != nil {
		return "", err
	}
	finalID := strings.TrimSpace(id)
	if finalID == "" {
		suffix, err := randomHex(6)
		if err != nil {
			return "", err
		}
		finalID = cardSlug(summary.Name) + "-" + suffix
	}
	path, err := artifactPath(cardKind, finalID)
	if err != nil {
		return "", err
	}
	if err := writeFileAtomic(path, normalized, filePerm); err != nil {
		return "", err
	}
	return finalID, nil
}

// DeleteCard moves a card to the app's Trash folder.
func (Library) DeleteCard(id string) error { return deleteArtifact(cardKind, id) }

// ListLorebooks returns the world books on disk, newest first.
func (Library) ListLorebooks() ([]Artifact, error) { return listArtifacts(lorebookKind) }

// LoadLorebook returns one world book's JSON, in the format it was saved in.
func (Library) LoadLorebook(id string) (string, error) { return loadArtifact(lorebookKind, id) }

// SaveLorebook writes a world book and returns the id it was stored under.
func (Library) SaveLorebook(id string, raw string) (string, error) {
	return saveArtifact(lorebookKind, id, raw)
}

// DeleteLorebook moves a world book to the app's Trash folder.
func (Library) DeleteLorebook(id string) error { return deleteArtifact(lorebookKind, id) }

// ImportLorebook shows a file picker and stores a SillyTavern world book.
// A cancelled picker returns a zero artifact with a nil error.
func (Library) ImportLorebook() (Artifact, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:  currentWindow(),
		Title:   "导入世界书",
		Message: "支持 SillyTavern 世界书 JSON",
		Filters: []mygo.FileFilter{{
			Name:       "世界书 JSON",
			Extensions: []string{"json"},
		}},
	})
	if err != nil {
		return Artifact{}, err
	}
	if len(paths) == 0 {
		return Artifact{}, nil
	}
	return importLorebookFromPath(paths[0])
}

// ImportLorebookFile imports a world book from a path relative to the app's
// inbox folder. A player picks any file through ImportLorebook; this endpoint
// never reaches outside the data directory.
func (Library) ImportLorebookFile(rel string) (Artifact, error) {
	root, err := inboxDir()
	if err != nil {
		return Artifact{}, err
	}
	path, err := resolveInside(root, rel)
	if err != nil {
		return Artifact{}, err
	}
	return importLorebookFromPath(path)
}

// importLorebookFromPath stores the world book file at an absolute path.
func importLorebookFromPath(path string) (Artifact, error) {
	info, err := os.Stat(path)
	if err != nil {
		return Artifact{}, publicError(err)
	}
	if info.IsDir() {
		return Artifact{}, errors.New("请选择一个世界书文件")
	}
	data, err := readLimited(path, maxImportBytes)
	if err != nil {
		return Artifact{}, publicError(err)
	}
	clean, err := decodeJSONObject(string(data), maxArtifactBytes)
	if err != nil {
		return Artifact{}, fmt.Errorf("导入失败：%w", err)
	}
	var probe struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal(clean, &probe)
	name := strings.TrimSpace(probe.Name)
	id := cardSlug(name)
	if id == "" {
		id = "lorebook"
	}
	suffix, err := randomHex(6)
	if err != nil {
		return Artifact{}, err
	}
	id = id + "-" + suffix
	dest, err := artifactPath(lorebookKind, id)
	if err != nil {
		return Artifact{}, err
	}
	if err := writeFileAtomic(dest, clean, filePerm); err != nil {
		return Artifact{}, err
	}
	return Library{}.LorebookArtifact(id)
}

// LorebookArtifact returns the list entry for one stored world book.
func (Library) LorebookArtifact(id string) (Artifact, error) {
	path, err := artifactPath(lorebookKind, id)
	if err != nil {
		return Artifact{}, err
	}
	raw, err := readLimited(path, maxArtifactBytes)
	if err != nil {
		return Artifact{}, fmt.Errorf("世界书读取失败：%w", publicError(err))
	}
	info, err := os.Stat(path)
	if err != nil {
		return Artifact{}, publicError(err)
	}
	name, detail := summarizeArtifact(lorebookKind, raw)
	if name == "" {
		name = id
	}
	return Artifact{
		ID:        id,
		Name:      name,
		Kind:      lorebookKind.label,
		Detail:    detail,
		Bytes:     info.Size(),
		UpdatedAt: info.ModTime(),
	}, nil
}

// ExportLorebook shows a save panel and writes the stored world book JSON.
// A cancelled panel returns an empty path with a nil error.
func (Library) ExportLorebook(id string) (string, error) {
	raw, err := loadArtifact(lorebookKind, id)
	if err != nil {
		return "", err
	}
	var probe struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal([]byte(raw), &probe)
	name := strings.TrimSpace(probe.Name)
	if name == "" {
		name = id
	}
	path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
		Parent:      currentWindow(),
		Title:       "导出世界书",
		DefaultPath: name + ".json",
		Filters: []mygo.FileFilter{{
			Name:       "世界书 JSON",
			Extensions: []string{"json"},
		}},
	})
	if err != nil {
		return "", err
	}
	target := strings.TrimSpace(path)
	if target == "" {
		return "", nil
	}
	if !strings.HasSuffix(strings.ToLower(target), ".json") {
		target += ".json"
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(target, []byte(raw), 0o644); err != nil {
		return "", err
	}
	return target, nil
}

// SaveTextFile shows a save panel and writes UTF-8 text, such as a hand-picked
// set of world book entries. A cancelled panel returns an empty path.
func (Library) SaveTextFile(defaultName string, content string) (string, error) {
	name := strings.TrimSpace(defaultName)
	if name == "" {
		name = "worldbook.json"
	}
	path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
		Parent:      currentWindow(),
		Title:       "导出世界书条目",
		DefaultPath: name,
		Filters: []mygo.FileFilter{{
			Name:       "世界书 JSON",
			Extensions: []string{"json"},
		}},
	})
	if err != nil {
		return "", err
	}
	target := strings.TrimSpace(path)
	if target == "" {
		return "", nil
	}
	if !strings.HasSuffix(strings.ToLower(target), ".json") {
		target += ".json"
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return "", err
	}
	return target, nil
}

// ExportWorld shows a save panel and writes the stored world JSON.
// A cancelled panel returns an empty path with a nil error.
func (Library) ExportWorld(id string) (string, error) {
	raw, err := loadArtifact(worldKind, id)
	if err != nil {
		return "", err
	}
	var probe struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal([]byte(raw), &probe)
	name := strings.TrimSpace(probe.Name)
	if name == "" {
		name = id
	}
	path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
		Parent:      currentWindow(),
		Title:       "导出世界",
		DefaultPath: name + ".json",
		Filters: []mygo.FileFilter{{
			Name:       "世界 JSON",
			Extensions: []string{"json"},
		}},
	})
	if err != nil {
		return "", err
	}
	target := strings.TrimSpace(path)
	if target == "" {
		return "", nil
	}
	if !strings.HasSuffix(strings.ToLower(target), ".json") {
		target += ".json"
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(target, []byte(raw), 0o644); err != nil {
		return "", err
	}
	return target, nil
}

// ImportCard shows a file picker and stores the chosen JSON, PNG or CHARX
// card. A cancelled picker returns a zero summary with a nil error.
func (Library) ImportCard() (CardSummary, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:  currentWindow(),
		Title:   "导入角色卡",
		Message: "支持角色卡 JSON、PNG 与 CHARX",
		Filters: []mygo.FileFilter{{
			Name:       "角色卡",
			Extensions: []string{"json", "png", "apng", "charx"},
		}},
	})
	if err != nil {
		return CardSummary{}, err
	}
	if len(paths) == 0 {
		return CardSummary{}, nil
	}
	return importCardFromPath(paths[0])
}

// ImportCardFile imports a card from a path relative to the app's inbox
// folder. A player picks any file through ImportCard; this endpoint never
// reaches outside the data directory.
func (Library) ImportCardFile(rel string) (CardSummary, error) {
	root, err := inboxDir()
	if err != nil {
		return CardSummary{}, err
	}
	path, err := resolveInside(root, rel)
	if err != nil {
		return CardSummary{}, err
	}
	return importCardFromPath(path)
}

// importCardFromPath stores the card file at an absolute path.
func importCardFromPath(path string) (CardSummary, error) {
	info, err := os.Stat(path)
	if err != nil {
		return CardSummary{}, publicError(err)
	}
	if info.IsDir() {
		return CardSummary{}, errors.New("请选择一个角色卡文件")
	}
	data, err := readLimited(path, maxImportBytes)
	if err != nil {
		return CardSummary{}, publicError(err)
	}
	normalized, summary, err := normalizeCard(data, "")
	if err != nil {
		return CardSummary{}, fmt.Errorf("导入失败：%w", err)
	}
	suffix, err := randomHex(6)
	if err != nil {
		return CardSummary{}, err
	}
	id := cardSlug(summary.Name) + "-" + suffix
	dest, err := artifactPath(cardKind, id)
	if err != nil {
		return CardSummary{}, err
	}
	if err := writeFileAtomic(dest, normalized, filePerm); err != nil {
		return CardSummary{}, err
	}
	summary.ID = id
	summary.UpdatedAt = time.Now()
	return summary, nil
}

// ExportCard shows a save panel and writes the card as V3 JSON. A cancelled
// panel returns an empty path with a nil error.
func (Library) ExportCard(id string) (string, error) {
	raw, err := loadArtifact(cardKind, id)
	if err != nil {
		return "", err
	}
	name := cardJSONName([]byte(raw))
	if name == "" {
		name = id
	}
	path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
		Parent:      currentWindow(),
		Title:       "导出角色卡",
		DefaultPath: name + ".json",
		Filters: []mygo.FileFilter{{
			Name:       "角色卡 JSON",
			Extensions: []string{"json"},
		}},
	})
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(path) == "" {
		return "", nil
	}
	return exportCardToPath(id, path)
}

// ExportCardTo writes the card as V3 JSON into the app's exports folder, at a
// path relative to it. ExportCard is the way to save anywhere on disk.
func (Library) ExportCardTo(id string, rel string) (string, error) {
	root, err := exportDir()
	if err != nil {
		return "", err
	}
	target, err := resolveInside(root, rel)
	if err != nil {
		return "", err
	}
	return exportCardToPath(id, target)
}

// exportCardToPath writes the card at an absolute path.
func exportCardToPath(id string, path string) (string, error) {
	raw, err := loadArtifact(cardKind, id)
	if err != nil {
		return "", err
	}
	target := strings.TrimSpace(path)
	if target == "" {
		return "", errors.New("没有指定保存位置")
	}
	if !strings.HasSuffix(strings.ToLower(target), ".json") {
		target += ".json"
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(target, []byte(raw), 0o644); err != nil {
		return "", err
	}
	return target, nil
}

// inboxDir is where files wait to be imported without a file picker: the only
// folder the page may name when it imports a file directly.
func inboxDir() (string, error) { return appDir("inbox") }

// exportDir is the only folder the page may write to without a save panel.
func exportDir() (string, error) { return appDir("exports") }

// artifactPath resolves a validated id to a file in the library.
func artifactPath(kind artifactKind, id string) (string, error) {
	clean, err := validID(id)
	if err != nil {
		return "", err
	}
	dir, err := appDir("library", kind.folder)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, clean+".json"), nil
}

// listArtifacts reads one library folder, skipping files it cannot parse.
func listArtifacts(kind artifactKind) ([]Artifact, error) {
	dir, err := appDir("library", kind.folder)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	list := make([]Artifact, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if _, err := validID(id); err != nil {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		artifact := Artifact{
			ID:        id,
			Kind:      kind.label,
			Bytes:     info.Size(),
			UpdatedAt: info.ModTime(),
		}
		artifact.Name, artifact.Detail = cachedArtifactSummary(kind, filepath.Join(dir, entry.Name()), info)
		if artifact.Name == "" {
			artifact.Name = id
		}
		list = append(list, artifact)
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].UpdatedAt.After(list[j].UpdatedAt)
	})
	return list, nil
}

// cachedArtifact is one parsed library entry, kept until the file changes.
type cachedArtifact struct {
	size   int64
	mod    time.Time
	name   string
	detail string
}

// artifactSummaries caches list entries by path, so refreshing the library
// does not re-read and re-parse every file.
var artifactSummaries struct {
	mu      sync.Mutex
	entries map[string]cachedArtifact
}

// cachedArtifactSummary returns the display name and detail of one file,
// parsing it only when its size or modification time changed.
func cachedArtifactSummary(kind artifactKind, path string, info fs.FileInfo) (string, string) {
	artifactSummaries.mu.Lock()
	cached, ok := artifactSummaries.entries[path]
	artifactSummaries.mu.Unlock()
	if ok && cached.size == info.Size() && cached.mod.Equal(info.ModTime()) {
		return cached.name, cached.detail
	}
	var name, detail string
	raw, err := readLimited(path, maxArtifactBytes)
	switch {
	case err == nil:
		name, detail = summarizeArtifact(kind, raw)
	case errors.Is(err, errTooLarge):
		detail = "文件过大，无法读取"
	default:
		detail = "文件无法读取"
	}
	artifactSummaries.mu.Lock()
	if artifactSummaries.entries == nil {
		artifactSummaries.entries = make(map[string]cachedArtifact)
	}
	artifactSummaries.entries[path] = cachedArtifact{size: info.Size(), mod: info.ModTime(), name: name, detail: detail}
	artifactSummaries.mu.Unlock()
	return name, detail
}

// summarizeArtifact reads the display name and a one-line detail for a list.
func summarizeArtifact(kind artifactKind, raw []byte) (string, string) {
	switch kind {
	case cardKind:
		return cardMeta(raw)
	case worldKind:
		var world struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Summary     string `json:"summary"`
		}
		if err := json.Unmarshal(raw, &world); err != nil {
			return "", ""
		}
		detail := strings.TrimSpace(world.Description)
		if detail == "" {
			detail = strings.TrimSpace(world.Summary)
		}
		if runes := []rune(detail); len(runes) > 80 {
			detail = string(runes[:80])
		}
		return strings.TrimSpace(world.Name), detail
	default:
		var book struct {
			Name    string          `json:"name"`
			Entries json.RawMessage `json:"entries"`
		}
		if err := json.Unmarshal(raw, &book); err != nil {
			return "", ""
		}
		count := 0
		var listed []json.RawMessage
		if json.Unmarshal(book.Entries, &listed) == nil {
			count = len(listed)
		} else {
			var keyed map[string]json.RawMessage
			if json.Unmarshal(book.Entries, &keyed) == nil {
				count = len(keyed)
			}
		}
		return strings.TrimSpace(book.Name), fmt.Sprintf("%d 条设定", count)
	}
}

// loadArtifact reads one stored JSON file.
func loadArtifact(kind artifactKind, id string) (string, error) {
	path, err := artifactPath(kind, id)
	if err != nil {
		return "", err
	}
	data, err := readLimited(path, maxArtifactBytes)
	if errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("找不到%s：%s", kind.label, id)
	}
	if err != nil {
		return "", fmt.Errorf("%s读取失败：%w", kind.label, publicError(err))
	}
	return string(data), nil
}

// saveArtifact stores a validated JSON object and returns its id.
func saveArtifact(kind artifactKind, id string, raw string) (string, error) {
	clean, err := decodeJSONObject(raw, maxArtifactBytes)
	if err != nil {
		return "", err
	}
	finalID := strings.TrimSpace(id)
	if finalID == "" {
		var probe struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(clean, &probe) == nil && idPattern.MatchString(probe.ID) {
			finalID = probe.ID
		} else {
			finalID, err = generatedID(kind.label)
			if err != nil {
				return "", err
			}
		}
	}
	if err := checkArtifactIdentity(kind, clean, finalID); err != nil {
		return "", err
	}
	path, err := artifactPath(kind, finalID)
	if err != nil {
		return "", err
	}
	if err := writeFileAtomic(path, clean, filePerm); err != nil {
		return "", err
	}
	return finalID, nil
}

// checkArtifactIdentity keeps a stored file and the id inside it in step. The
// page round-trips a world's id, so a mismatch means two files would claim the
// same world; imported world books keep their own keys instead.
func checkArtifactIdentity(kind artifactKind, clean []byte, id string) error {
	if kind != worldKind {
		return nil
	}
	var probe struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(clean, &probe) != nil {
		return nil
	}
	inner := strings.TrimSpace(probe.ID)
	if inner == "" || !idPattern.MatchString(inner) || inner == id {
		return nil
	}
	return fmt.Errorf("世界标识不一致：内容里是 %s，保存目标是 %s", inner, id)
}

// deleteArtifact moves one stored file to the app's Trash folder.
func deleteArtifact(kind artifactKind, id string) error {
	path, err := artifactPath(kind, id)
	if err != nil {
		return err
	}
	if err := moveToTrash(path); err != nil {
		if errors.Is(err, errNotExist) {
			return fmt.Errorf("找不到%s：%s", kind.label, id)
		}
		return publicError(err)
	}
	return nil
}
