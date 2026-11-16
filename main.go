package main

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/fetch"
)

// Settings is callable from the frontend: `mygo generate` turns its methods
// into typed TypeScript functions in src/mygo.ts.
type Settings struct{}

// Config is what the app keeps between launches. It describes one endpoint,
// so the app can talk to any OpenAI- or Anthropic-compatible service.
type Config struct {
	// Kind is the wire protocol: "openai" or "anthropic".
	Kind string `json:"kind"`
	// BaseURL is the endpoint root the provider is called at.
	BaseURL string `json:"baseUrl"`
	// Model is the model id sent in requests.
	Model string `json:"model"`
	// APIKey is stored on disk only, readable by the user alone.
	APIKey string `json:"apiKey,omitempty"`
	// Theme is "system", "light" or "dark".
	Theme string `json:"theme"`
	// Prompt replaces the built-in system prompt when it is not empty.
	Prompt string `json:"prompt,omitempty"`
}

// defaults apply until the user saves settings of their own.
var defaults = Config{Kind: "openai", Theme: "system"}

func configPath() (string, error) {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

// Load returns the saved configuration, or the defaults when none is saved.
func (Settings) Load() (Config, error) {
	path, err := configPath()
	if err != nil {
		return Config{}, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return defaults, nil
	}
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, err
	}
	if cfg.Kind != "anthropic" {
		cfg.Kind = "openai"
	}
	if cfg.Theme != "light" && cfg.Theme != "dark" {
		cfg.Theme = "system"
	}
	return cfg, nil
}

// Save writes the configuration for the next launch. The file is created
// readable by the user alone, because it holds the API key.
func (Settings) Save(cfg Config) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func main() {
	// Model requests leave from Go: no CORS, any header, streamed both ways.
	mygo.Use(fetch.Plugin)
	mygo.Bind(Settings{})

	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:           "AppleCos",
			Width:           980,
			Height:          720,
			MinWidth:        560,
			MinHeight:       440,
			BackgroundColor: "light-dark(#f2ede1, #0c0d0b)",
			StateKey:        "main",
			URL:             "/",
		})
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
