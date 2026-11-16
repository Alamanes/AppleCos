package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

// CardSummary describes an imported character card for the library list.
type CardSummary struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Spec        string    `json:"spec"`
	SpecVersion string    `json:"specVersion"`
	Source      string    `json:"source"`
	HasBook     bool      `json:"hasBook"`
	Bytes       int64     `json:"bytes"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// pngSignature starts every PNG/APNG file.
var pngSignature = []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}

// zipSignature starts a local zip header, which CHARX files begin with.
var zipSignature = []byte{0x50, 0x4b, 0x03, 0x04}

// normalizeCard turns a JSON, PNG or CHARX card into the V3 object this app
// stores, and summarizes it. data is only read, never modified.
func normalizeCard(data []byte, source string) ([]byte, CardSummary, error) {
	payload, kind, err := extractCardJSON(data)
	if err != nil {
		return nil, CardSummary{}, err
	}
	if source == "" {
		source = kind
	}
	var obj map[string]any
	if err := json.Unmarshal(payload, &obj); err != nil {
		return nil, CardSummary{}, errors.New("角色卡不是合法的 JSON")
	}
	normalized, err := normalizeCardObject(obj)
	if err != nil {
		return nil, CardSummary{}, err
	}
	out, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		return nil, CardSummary{}, err
	}
	summary := CardSummary{
		Spec:        "chara_card_v3",
		SpecVersion: "3.0",
		Source:      source,
		Bytes:       int64(len(out)),
		UpdatedAt:   time.Now(),
	}
	dataObj, _ := normalized["data"].(map[string]any)
	if dataObj != nil {
		summary.Name, _ = dataObj["name"].(string)
		summary.HasBook = hasBookEntries(dataObj["character_book"])
	}
	if summary.Name == "" {
		summary.Name = "未命名角色"
	}
	return out, summary, nil
}

// extractCardJSON returns the JSON payload and the transport it came from.
func extractCardJSON(data []byte) ([]byte, string, error) {
	if len(data) == 0 {
		return nil, "", errors.New("文件是空的")
	}
	if bytes.HasPrefix(data, pngSignature) {
		payload, err := pngCardJSON(data)
		return payload, "png", err
	}
	if bytes.HasPrefix(data, zipSignature) {
		payload, err := charxCardJSON(data)
		return payload, "charx", err
	}
	return bytes.TrimPrefix(bytes.TrimSpace(data), bomPrefix), "json", nil
}

// pngCardJSON reads the ccv3 or chara text chunk a character card carries.
func pngCardJSON(data []byte) ([]byte, error) {
	const headerLen = 8
	if len(data) < headerLen+8 {
		return nil, errors.New("PNG 文件不完整")
	}
	chunks := map[string][]byte{}
	offset := headerLen
	for offset+8 <= len(data) {
		length := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		kind := string(data[offset+4 : offset+8])
		offset += 8
		if length < 0 || offset+length+4 > len(data) {
			return nil, errors.New("PNG 数据被截断")
		}
		payload := data[offset : offset+length]
		if kind == "tEXt" {
			if keyword, text, ok := splitTextChunk(payload); ok {
				if _, seen := chunks[keyword]; !seen {
					chunks[keyword] = text
				}
			}
		}
		offset += length + 4
		if len(chunks["ccv3"]) > 0 && len(chunks["chara"]) > 0 {
			break
		}
	}
	for _, keyword := range []string{"ccv3", "chara"} {
		if text, ok := chunks[keyword]; ok && len(text) > 0 {
			return decodeBase64Text(text)
		}
	}
	return nil, errors.New("这张 PNG 里没有角色卡数据（ccv3 或 chara 块）")
}

// splitTextChunk splits a tEXt payload into its keyword and text.
func splitTextChunk(payload []byte) (string, []byte, bool) {
	for i, b := range payload {
		if b == 0 {
			return string(payload[:i]), payload[i+1:], true
		}
	}
	return "", nil, false
}

// charxCardJSON reads card.json from a CHARX archive.
func charxCardJSON(data []byte) ([]byte, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, errors.New("CHARX 不是合法的 zip 文件")
	}
	var fallback *zip.File
	for _, file := range reader.File {
		name := strings.TrimPrefix(file.Name, "./")
		if name == "card.json" {
			return readZipEntry(file)
		}
		if fallback == nil && !strings.Contains(name, "/") && strings.HasSuffix(strings.ToLower(name), ".json") {
			fallback = file
		}
	}
	if fallback != nil {
		return readZipEntry(fallback)
	}
	return nil, errors.New("CHARX 里没有 card.json")
}

// readZipEntry reads one archive member with a size limit.
func readZipEntry(file *zip.File) ([]byte, error) {
	if file.UncompressedSize64 > uint64(maxImportBytes) {
		return nil, errors.New("CHARX 里的 card.json 过大")
	}
	stream, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer func() { _ = stream.Close() }()
	payload, err := io.ReadAll(io.LimitReader(stream, maxImportBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(payload)) > maxImportBytes {
		return nil, errors.New("CHARX 里的 card.json 过大")
	}
	return payload, nil
}

// decodeBase64Text accepts base64 with the whitespace editors add.
func decodeBase64Text(raw []byte) ([]byte, error) {
	text := strings.Map(func(r rune) rune {
		switch r {
		case 0x20, 0x0a, 0x0d, 0x09:
			return -1
		}
		return r
	}, string(raw))
	if text == "" {
		return nil, errors.New("角色卡数据是空的")
	}
	encodings := []*base64.Encoding{
		base64.StdEncoding, base64.RawStdEncoding,
		base64.URLEncoding, base64.RawURLEncoding,
	}
	for _, encoding := range encodings {
		if decoded, err := encoding.DecodeString(text); err == nil {
			return decoded, nil
		}
	}
	return nil, errors.New("角色卡数据不是合法的 base64")
}

// normalizeCardObject upgrades a V1 or V2 card to the V3 shape, keeping the
// fields this app does not know about. V3 passes through unchanged.
func normalizeCardObject(obj map[string]any) (map[string]any, error) {
	spec, _ := obj["spec"].(string)
	var data map[string]any
	switch spec {
	case "chara_card_v3", "chara_card_v2":
		inner, ok := obj["data"].(map[string]any)
		if !ok {
			return nil, errors.New("角色卡缺少 data")
		}
		data = inner
	default:
		if _, ok := obj["data"].(map[string]any); ok {
			return nil, fmt.Errorf("无法识别的角色卡格式：%q", spec)
		}
		if _, ok := obj["name"].(string); !ok {
			return nil, errors.New("无法识别的角色卡：既不是 V1，也不是 V2/V3")
		}
		data = make(map[string]any, len(obj))
		for key, value := range obj {
			data[key] = value
		}
	}
	fillCardDefaults(data)
	return map[string]any{
		"spec":         "chara_card_v3",
		"spec_version": "3.0",
		"data":         data,
	}, nil
}

// fillCardDefaults gives every V3 field a usable zero value without touching
// values the card already carries.
func fillCardDefaults(data map[string]any) {
	for _, key := range []string{
		"name", "description", "personality", "scenario", "first_mes",
		"mes_example", "system_prompt", "post_history_instructions",
		"creator_notes", "creator", "character_version",
	} {
		if _, ok := data[key].(string); !ok {
			data[key] = ""
		}
	}
	for _, key := range []string{"alternate_greetings", "tags", "group_only_greetings"} {
		if _, ok := data[key].([]any); !ok {
			data[key] = []any{}
		}
	}
	if _, ok := data["extensions"].(map[string]any); !ok {
		data["extensions"] = map[string]any{}
	}
	if strings.TrimSpace(data["name"].(string)) == "" {
		data["name"] = "未命名角色"
	}
}

// hasBookEntries reports whether a character_book carries entries.
func hasBookEntries(raw any) bool {
	book, ok := raw.(map[string]any)
	if !ok {
		return false
	}
	entries, ok := book["entries"].([]any)
	return ok && len(entries) > 0
}

// cardSlug builds the readable part of a card id from its name.
func cardSlug(name string) string {
	var builder strings.Builder
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			builder.WriteRune(r)
		case r == '-' || r == '_' || r == ' ' || r == 0x09:
			builder.WriteByte('-')
		}
		if builder.Len() >= 32 {
			break
		}
	}
	slug := strings.Trim(builder.String(), "-")
	if slug == "" {
		slug = "card"
	}
	return slug
}

// cardMeta reads the name and a one-line detail out of a stored V3 card.
func cardMeta(raw []byte) (string, string) {
	var obj struct {
		Data struct {
			Name string          `json:"name"`
			Book json.RawMessage `json:"character_book"`
			Tags []string        `json:"tags"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return "", ""
	}
	name := strings.TrimSpace(obj.Data.Name)
	detail := "角色卡"
	if len(obj.Data.Tags) > 0 {
		detail += " · " + strings.Join(obj.Data.Tags[:minInt(len(obj.Data.Tags), 3)], "、")
	}
	if hasBookJSON(obj.Data.Book) {
		detail += " · 含世界书"
	}
	return name, detail
}

// hasBookJSON reports whether a raw character_book has entries, in either
// the array form this app writes or the uid-keyed map SillyTavern exports.
func hasBookJSON(raw json.RawMessage) bool {
	if len(raw) == 0 || raw[0] != '{' {
		return false
	}
	var book struct {
		Entries json.RawMessage `json:"entries"`
	}
	if json.Unmarshal(raw, &book) != nil || len(book.Entries) == 0 {
		return false
	}
	var listed []json.RawMessage
	if json.Unmarshal(book.Entries, &listed) == nil && len(listed) > 0 {
		return true
	}
	var keyed map[string]json.RawMessage
	return json.Unmarshal(book.Entries, &keyed) == nil && len(keyed) > 0
}

// cardJSONName reads the display name from any card JSON.
func cardJSONName(raw []byte) string {
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil {
		return ""
	}
	if data := jsonObject(obj["data"]); data != nil {
		if name := jsonString(data["name"]); name != "" {
			return name
		}
	}
	return jsonString(obj["name"])
}

// minInt returns the smaller of two ints.
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
