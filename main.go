package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

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
	// Tools is the older single switch: true while any per-tool flag is on.
	Tools bool `json:"tools"`
	// ToolsDice enables the dice tool.
	ToolsDice bool `json:"toolsDice"`
	// ToolsTime enables the in-world clock tool.
	ToolsTime bool `json:"toolsTime"`
	// ToolsScene enables the scene tool.
	ToolsScene bool `json:"toolsScene"`
	// ToolsLore enables the world info lookup tool.
	ToolsLore bool `json:"toolsLore"`
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
	ToolsDice:     true,
	ToolsTime:     true,
	ToolsScene:    true,
	ToolsLore:     true,
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
	data, err := readLimited(path, maxConfigBytes)
	if errors.Is(err, fs.ErrNotExist) {
		return defaults, nil
	}
	if err != nil {
		return Config{}, fmt.Errorf("配置读取失败：%w", publicError(err))
	}
	cfg := defaults
	if err := json.Unmarshal(data, &cfg); err != nil {
		// A hand edit or a crash left the file unreadable: keep it, so the next
		// save cannot erase the endpoint, the prompt and the key it held.
		keepCorruptConfig(path, err)
		return defaults, nil
	}
	var probe map[string]json.RawMessage
	if json.Unmarshal(data, &probe) == nil {
		if _, ok := probe["confirm"]; !ok {
			cfg.Confirm = true
		}
		if features, ok := probe["features"]; !ok {
			cfg.Features = defaultFeatures
		} else {
			applyToolFallbacks(&cfg.Features, features)
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
	// The file holds the API key: write it through the atomic path, which also
	// applies 0600 to the replacement instead of keeping the old mode.
	if err := writeFileAtomic(path, data, filePerm); err != nil {
		return fmt.Errorf("保存配置失败：%w", publicError(err))
	}
	return nil
}

// keepCorruptConfig moves a configuration file this build cannot parse aside.
func keepCorruptConfig(path string, cause error) {
	log.Printf("config: unreadable: %v", cause)
	target := path + ".corrupt-" + time.Now().Format("20060102-150405")
	if err := os.Rename(path, target); err != nil {
		log.Printf("config: keeping the unreadable file failed: %v", err)
		return
	}
	log.Printf("config: kept an unreadable file as %s", target)
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

// applyToolFallbacks fills the per-tool switches a config file predates. A file
// with none of them can only say whether any tool was on; with some of them,
// the rest read as enabled, which is how the page shows a partial set.
func applyToolFallbacks(features *Features, raw json.RawMessage) {
	var present map[string]json.RawMessage
	if json.Unmarshal(raw, &present) != nil {
		// Not an object: treat it as a file without any per-tool switch.
		present = nil
	}
	known := false
	for _, key := range []string{"toolsDice", "toolsTime", "toolsScene", "toolsLore"} {
		if _, ok := present[key]; ok {
			known = true
			break
		}
	}
	fallback := features.Tools
	if known {
		fallback = true
	}
	if _, ok := present["toolsDice"]; !ok {
		features.ToolsDice = fallback
	}
	if _, ok := present["toolsTime"]; !ok {
		features.ToolsTime = fallback
	}
	if _, ok := present["toolsScene"]; !ok {
		features.ToolsScene = fallback
	}
	if _, ok := present["toolsLore"]; !ok {
		features.ToolsLore = fallback
	}
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

// windowColor accepts the color syntax the window layer understands: a hex
// color, or a light/dark pair of them.
var windowColor = regexp.MustCompile("^(#[0-9a-fA-F]{3,8}|light-dark[(] *#[0-9a-fA-F]{3,8} *, *#[0-9a-fA-F]{3,8} *[)])$")

// SetWindowBackground sets the color painted behind the page, in the syntax
// of the window options, such as "light-dark(#f5f7fb, #12151f)".
func (Shell) SetWindowBackground(color string) error {
	window := mainWindow.Load()
	if window == nil {
		return errors.New("窗口还没有就绪")
	}
	trimmed := strings.TrimSpace(color)
	if !windowColor.MatchString(trimmed) {
		return fmt.Errorf("不支持的颜色值：%q", color)
	}
	return window.SetBackgroundColor(trimmed)
}

// beforeQuit tells the page that the app is going away, so it can finish the
// saves it has queued. A page that does not listen only costs the grace
// period.
var beforeQuit = mygo.NewEvent[string]("app:before-quit")

// quitGrace is how long the window waits for the page's save chain.
const quitGrace = 300 * time.Millisecond

// quitting marks a close that already asked the page to flush.
var quitting atomic.Bool

// watchQuit flushes the page before the window closes. The second close of the
// same exit passes straight through.
func watchQuit(window *mygo.Window) {
	window.OnClose(func(e *mygo.CloseEvent) {
		if quitting.Load() {
			return
		}
		e.PreventDefault()
		_ = beforeQuit.Emit(window, "close")
		quitting.Store(true)
		go func() {
			time.Sleep(quitGrace)
			window.Close()
		}()
	})
	mygo.App.OnBeforeQuit(func(e *mygo.QuitEvent) {
		// The operating system ends the session on its own terms; do not hold it.
		if e.SessionEnding || quitting.Load() {
			return
		}
		e.PreventDefault()
		_ = beforeQuit.Emit(window, "quit")
		quitting.Store(true)
		go func() {
			time.Sleep(quitGrace)
			mygo.App.Quit()
		}()
	})
}

func main() {
	// Model requests leave from Go: no CORS, any header, streamed both ways.
	mygo.Use(fetch.Plugin)
	mygo.Bind(Settings{}, Library{}, Sessions{}, Shell{})

	// Old deletions expire so the recovery folder cannot grow without limit.
	pruneTrash()

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
		watchQuit(window)
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
