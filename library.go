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
		finalID = cardSlug(summary.Name) + "-" + randomHex(6)
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
	return Library{}.ImportLorebookFile(paths[0])
}

// ImportLorebookFile imports a world book from a path, without a file picker.
func (Library) ImportLorebookFile(path string) (Artifact, error) {
	info, err := os.Stat(path)
	if err != nil {
		return Artifact{}, err
	}
	if info.IsDir() {
		return Artifact{}, errors.New("请选择一个世界书文件")
	}
	data, err := readLimited(path, maxImportBytes)
	if err != nil {
		return Artifact{}, err
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
	id = id + "-" + randomHex(6)
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
		return Artifact{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return Artifact{}, err
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
	return Library{}.ImportCardFile(paths[0])
}

// ImportCardFile imports a card from a path, without a file picker.
func (Library) ImportCardFile(path string) (CardSummary, error) {
	info, err := os.Stat(path)
	if err != nil {
		return CardSummary{}, err
	}
	if info.IsDir() {
		return CardSummary{}, errors.New("请选择一个角色卡文件")
	}
	data, err := readLimited(path, maxImportBytes)
	if err != nil {
		return CardSummary{}, err
	}
	normalized, summary, err := normalizeCard(data, "")
	if err != nil {
		return CardSummary{}, fmt.Errorf("导入失败：%w", err)
	}
	id := cardSlug(summary.Name) + "-" + randomHex(6)
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
	return Library{}.ExportCardTo(id, path)
}

// ExportCardTo writes the card as V3 JSON at path, without a save panel.
func (Library) ExportCardTo(id string, path string) (string, error) {
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
		if raw, err := readLimited(filepath.Join(dir, entry.Name()), maxArtifactBytes); err == nil {
			artifact.Name, artifact.Detail = summarizeArtifact(kind, raw)
		}
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
	if errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("找不到%s：%s", kind.label, id)
	}
	if err != nil {
		return "", err
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
			finalID = generatedID(kind.label)
		}
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

// deleteArtifact moves one stored file to the app's Trash folder.
func deleteArtifact(kind artifactKind, id string) error {
	path, err := artifactPath(kind, id)
	if err != nil {
		return err
	}
	return moveToTrash(path)
}
