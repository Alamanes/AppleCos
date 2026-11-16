package main

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sync/atomic"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/fetch"
)

// Settings is callable from the frontend: `mygo generate` turns its methods
// into typed TypeScript functions in src/mygo.ts.
type Settings struct{}

// Features toggles optional parts of the interface, so a saved layout keeps
// working when a panel is hidden later.
type Features struct {
	// WorldPanel shows the world sidebar.
	WorldPanel bool `json:"worldPanel"`
	// WorldClock shows the in-world date and time.
	WorldClock bool `json:"worldClock"`
	// ScriptMode renders the transcript as a script.
	ScriptMode bool `json:"scriptMode"`
	// Typewriter reveals replies while they stream.
	Typewriter bool `json:"typewriter"`
	// AutoTitle names a conversation from its first exchange.
	AutoTitle bool `json:"autoTitle"`
	// ReduceMotion turns off decorative animation.
	ReduceMotion bool `json:"reduceMotion"`
	// ShowLatency shows how long a reply took.
	ShowLatency bool `json:"showLatency"`
	// Worldbook enables world info triggers.
	Worldbook bool `json:"worldbook"`
	// Memory enables long-term memory.
	Memory bool `json:"memory"`
	// Tools lets the model call the memory tools.
	Tools bool `json:"tools"`
	// DeveloperMode shows trigger logs and raw payloads.
	DeveloperMode bool `json:"developerMode"`
}

// Config is what the app keeps between launches. It describes one endpoint,
// so the app can talk to any OpenAI- or Anthropic-compatible service, plus the
// budgets the story engine reads.
type Config struct {
	// Kind is the wire protocol: "openai" or "anthropic".
	Kind string `json:"kind"`
	// BaseURL is the endpoint root the provider is called at.
	BaseURL string `json:"baseUrl"`
	// Shape selects the OpenAI API family: "chat" or "responses".
	// Ignored when Kind is "anthropic".
	Shape string `json:"shape"`
	// Model is the model id sent in requests.
	Model string `json:"model"`
	// APIKey is stored on disk only, readable by the user alone.
	APIKey string `json:"apiKey,omitempty"`
	// Theme is "system", "nocturne", "atlas", "terminal", "press" or "ember".
	Theme string `json:"theme"`
	// Prompt replaces the built-in system prompt when it is not empty.
	Prompt string `json:"prompt,omitempty"`
	// Reasoning is the thinking budget: "off", "low", "medium" or "high".
	Reasoning string `json:"reasoning"`
	// ContextWindow is the model's context size in tokens, used for history
	// trimming and world info budgets.
	ContextWindow int `json:"contextWindow"`
	// BudgetPct is the share of the context world info may use.
	BudgetPct int `json:"budgetPct"`
	// TriggerBudget caps the tokens one world info scan may insert.
	TriggerBudget int `json:"triggerBudget"`
	// Confirm asks before actions that discard a conversation or a card.
	Confirm bool `json:"confirm"`
	// Features toggles optional interface parts.
	Features Features `json:"features"`
}

// defaultFeatures is what a fresh install and an older config file get.
var defaultFeatures = Features{
	WorldPanel:    true,
	WorldClock:    true,
	ScriptMode:    true,
	Typewriter:    true,
	AutoTitle:     true,
	ReduceMotion:  false,
	ShowLatency:   false,
	Worldbook:     true,
	Memory:        true,
	Tools:         true,
	DeveloperMode: false,
}

// defaults apply until the user saves settings of their own.
var defaults = Config{
	Kind:          "openai",
	Shape:         "chat",
	Theme:         "system",
	Reasoning:     "off",
	ContextWindow: 128000,
	BudgetPct:     25,
	TriggerBudget: 2000,
	Confirm:       true,
	Features:      defaultFeatures,
}

func configPath() (string, error) {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

// Load returns the saved configuration, or the defaults when none is saved.
// Older files predate fields here, so missing values keep their defaults.
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
	cfg := defaults
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, err
	}
	var probe map[string]json.RawMessage
	if json.Unmarshal(data, &probe) == nil {
		if _, ok := probe["confirm"]; !ok {
			cfg.Confirm = true
		}
		if _, ok := probe["features"]; !ok {
			cfg.Features = defaultFeatures
		}
	}
	normalizeConfig(&cfg)
	return cfg, nil
}

// Save writes the configuration for the next launch. The file is created
// readable by the user alone, because it holds the API key.
func (Settings) Save(cfg Config) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	normalizeConfig(&cfg)
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// normalizeConfig repairs values an older config file or a hand edit left
// outside the accepted range.
func normalizeConfig(cfg *Config) {
	if cfg.Kind != "anthropic" {
		cfg.Kind = "openai"
	}
	if cfg.Shape != "responses" {
		cfg.Shape = "chat"
	}
	cfg.Theme = normalizeTheme(cfg.Theme)
	cfg.Reasoning = normalizeReasoning(cfg.Reasoning)
	// A page that predates features sends none; keep the defaults rather than
	// switching every panel off.
	if cfg.Features == (Features{}) {
		cfg.Features = defaultFeatures
	}
	cfg.ContextWindow = clampInt(cfg.ContextWindow, 2048, 2000000, 128000)
	cfg.BudgetPct = clampInt(cfg.BudgetPct, 5, 100, 25)
	cfg.TriggerBudget = clampInt(cfg.TriggerBudget, 100, 200000, 2000)
}

// normalizeReasoning keeps an unknown thinking level on "off", which is what
// an older config file and a hand edit both fall back to.
func normalizeReasoning(reasoning string) string {
	switch reasoning {
	case "off", "low", "medium", "high":
		return reasoning
	}
	return "off"
}

// normalizeTheme maps the retired light and dark themes onto the palettes
// that replaced them.
func normalizeTheme(theme string) string {
	switch theme {
	case "light":
		return "press"
	case "dark":
		return "nocturne"
	case "system", "nocturne", "atlas", "terminal", "press", "ember", "xuanzhi", "dawn", "moss":
		return theme
	}
	return "system"
}

// clampInt keeps a number inside a range, taking the fallback for the zero
// value a missing field leaves behind.
func clampInt(value, low, high, fallback int) int {
	if value == 0 {
		return fallback
	}
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

// mainWindow is the window the page is shown in. Shell methods use it; it is
// nil while the client is generated, when no window opens.
var mainWindow atomic.Pointer[mygo.Window]

// currentWindow returns the open window, or nil before it exists.
func currentWindow() *mygo.Window {
	return mainWindow.Load()
}

// Shell exposes window and application lifecycle to the page.
type Shell struct{}

// Quit closes every window and exits the app.
func (Shell) Quit() {
	mygo.App.Quit()
}

// SetWindowBackground sets the color painted behind the page, in the syntax
// of the window options, such as "light-dark(#f5f7fb, #12151f)".
func (Shell) SetWindowBackground(color string) error {
	window := mainWindow.Load()
	if window == nil {
		return errors.New("窗口还没有就绪")
	}
	return window.SetBackgroundColor(color)
}

func main() {
	// Model requests leave from Go: no CORS, any header, streamed both ways.
	mygo.Use(fetch.Plugin)
	mygo.Bind(Settings{}, Library{}, Sessions{}, Shell{})

	mygo.App.WhenReady(func() {
		window := mygo.NewWindow(mygo.WindowOptions{
			Title:           "AppleCos",
			Width:           980,
			Height:          720,
			MinWidth:        560,
			MinHeight:       440,
			BackgroundColor: "light-dark(#f5f7fb, #12151f)",
			StateKey:        "main",
			// The page draws its own title bar; the traffic lights stay on top.
			TitleBarStyle: mygo.TitleBarHiddenInset,
			URL:           "/",
		})
		mainWindow.Store(window)
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
