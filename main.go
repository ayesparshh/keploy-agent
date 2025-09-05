package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Message types for communication with the agent
type MessageType string

const (
	MsgInit        MessageType = "init"
	MsgChat        MessageType = "chat"
	MsgError       MessageType = "error"
	MsgResponse    MessageType = "response"
	MsgToolCall    MessageType = "tool_call"
	MsgStreamChunk MessageType = "stream_chunk"
)

type AgentMessage struct {
	Type MessageType     `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

// App states
type AppState int

const (
	StateAPIKey AppState = iota
	StateChat
)

// Chat message for display
type ChatMessage struct {
	Role      string // "user", "assistant", "system", "tool"
	Content   string
	Timestamp time.Time
	IsError   bool
}

// Tool call information
type ToolCallInfo struct {
	ToolName string                 `json:"toolName"`
	Args     map[string]interface{} `json:"args"`
}

// Model for our Keploy Agent application
type Model struct {
	state        AppState
	apiKeyInput  textinput.Model
	chatInput    textarea.Model
	viewport     viewport.Model
	messages     []ChatMessage
	agentProcess *exec.Cmd
	agentStdin   io.WriteCloser
	agentStdout  io.ReadCloser
	agentReady   bool
	width        int
	height       int
	err          error
	isProcessing bool
	workDir      string // Store the working directory
}

// Styles
var (
	appStyle = lipgloss.NewStyle().
			Padding(1, 2)

	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#7D56F4")).
			PaddingBottom(1)

	statusStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#626262"))

	userMsgStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#86EFAC")).
			Bold(true)

	assistantMsgStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#93C5FD"))

	toolMsgStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FDE047")).
			Italic(true)

	errorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#EF4444")).
			Bold(true)

	inputStyle = lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("#7D56F4")).
			Padding(0, 1)

	helpStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#626262")).
			Italic(true)
)

// Messages for the update loop
type agentResponseMsg struct {
	message AgentMessage
}

type errMsg struct {
	err error
}

func initialModel() Model {
	// API Key input
	ti := textinput.New()
	ti.Placeholder = "Gemini API key"
	ti.Focus()
	ti.CharLimit = 200 // Increased to handle longer keys
	ti.Width = 80      // Increased width to show more of the key
	ti.EchoMode = textinput.EchoPassword

	// Chat input
	ta := textarea.New()
	ta.Placeholder = "Type your message..."
	ta.CharLimit = 500
	ta.SetWidth(60)
	ta.SetHeight(3)

	// Viewport for messages
	vp := viewport.New(80, 20)
	vp.SetContent("Welcome to Keploy Agent!\n\nPlease enter your Google API key to begin.")

	workDir := os.Getenv("KEPLOY_WORK_DIR")
	if workDir == "" {
		if wd, err := os.Getwd(); err == nil {
			workDir = wd
		} else {
			workDir = "."
		}
	}

	return Model{
		state:       StateAPIKey,
		apiKeyInput: ti,
		chatInput:   ta,
		viewport:    vp,
		messages:    []ChatMessage{},
		agentReady:  false,
		workDir:     workDir,
	}
}

func (m Model) Init() tea.Cmd {
	return textinput.Blink
}

type agentStartedMsg struct {
	process *exec.Cmd
	stdin   io.WriteCloser
	stdout  io.ReadCloser
}

func (m Model) startAgent(apiKey string) tea.Cmd {
	return func() tea.Msg {
		// Check if agent directory exists
		if _, err := os.Stat("./agent"); os.IsNotExist(err) {
			return errMsg{err: fmt.Errorf("agent directory not found. Please run from the keploy-agent directory")}
		}

		// Start the TypeScript agent process
		cmd := exec.Command("npm", "start")
		cmd.Dir = "./agent"

		// Set up pipes
		stdin, err := cmd.StdinPipe()
		if err != nil {
			return errMsg{err: fmt.Errorf("failed to create stdin pipe: %w", err)}
		}

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return errMsg{err: fmt.Errorf("failed to create stdout pipe: %w", err)}
		}

		// Redirect stderr to a file for debugging
		errFile, err := os.Create("agent-error.log")
		if err == nil {
			cmd.Stderr = errFile
		}

		// Start the process
		if err := cmd.Start(); err != nil {
			return errMsg{err: fmt.Errorf("failed to start agent: %w", err)}
		}

		// Send initialization message
		initMsg := AgentMessage{
			Type: MsgInit,
			Data: json.RawMessage(fmt.Sprintf(`{"apiKey":"%s"}`, apiKey)),
		}

		msgBytes, _ := json.Marshal(initMsg)
		stdin.Write(msgBytes)
		stdin.Write([]byte("\n"))

		// Return message with the process info
		return agentStartedMsg{
			process: cmd,
			stdin:   stdin,
			stdout:  stdout,
		}
	}
}

func (m Model) listenToAgent() tea.Cmd {
	return func() tea.Msg {
		if m.agentStdout == nil {
			return errMsg{err: fmt.Errorf("agent stdout is nil")}
		}

		scanner := bufio.NewScanner(m.agentStdout)
		// Process ONE message and return it
		// The Update function will call listenToAgent again to continue
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}

			var msg AgentMessage
			if err := json.Unmarshal([]byte(line), &msg); err != nil {
				continue
			}

			// Return this message and let Update reschedule listening
			return agentResponseMsg{message: msg}
		}

		if err := scanner.Err(); err != nil {
			return errMsg{err: fmt.Errorf("agent stream error: %w", err)}
		}

		// Agent closed the stream
		return errMsg{err: fmt.Errorf("agent stream closed unexpectedly")}
	}
}

func (m Model) sendChatMessage(message string) tea.Cmd {
	return func() tea.Msg {
		if m.agentStdin == nil {
			return errMsg{err: fmt.Errorf("agent not initialized")}
		}

		chatMsg := AgentMessage{
			Type: MsgChat,
			Data: json.RawMessage(fmt.Sprintf(`{"message":"%s"}`, strings.ReplaceAll(message, "\"", "\\\""))),
		}

		msgBytes, _ := json.Marshal(chatMsg)
		m.agentStdin.Write(msgBytes)
		m.agentStdin.Write([]byte("\n"))

		return nil
	}
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC, tea.KeyEsc:
			// Clean shutdown
			if m.agentProcess != nil {
				m.agentProcess.Process.Kill()
			}
			return m, tea.Quit

		case tea.KeyEnter:
			if m.state == StateAPIKey && !m.isProcessing {
				apiKey := m.apiKeyInput.Value()
				if apiKey != "" {
					m.isProcessing = true
					cmds = append(cmds, m.startAgent(apiKey))
				}
			} else if m.state == StateChat && !strings.Contains(m.chatInput.Value(), "\n") {
				// Send message on Enter if not in multiline mode (no newlines present)
				message := strings.TrimSpace(m.chatInput.Value())
				if message != "" && m.agentReady && !m.isProcessing {
					m.messages = append(m.messages, ChatMessage{
						Role:      "user",
						Content:   message,
						Timestamp: time.Now(),
					})
					m.chatInput.Reset()
					m.isProcessing = true
					m.updateViewport()
					cmds = append(cmds, m.sendChatMessage(message))
				}
			}

		case tea.KeyCtrlS:
			// Send message with Ctrl+S in chat mode
			if m.state == StateChat {
				message := strings.TrimSpace(m.chatInput.Value())
				if message != "" && m.agentReady && !m.isProcessing {
					m.messages = append(m.messages, ChatMessage{
						Role:      "user",
						Content:   message,
						Timestamp: time.Now(),
					})
					m.chatInput.Reset()
					m.isProcessing = true
					m.updateViewport()
					cmds = append(cmds, m.sendChatMessage(message))
				}
			}
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

		// Update viewport size
		headerHeight := 6
		footerHeight := 8
		m.viewport.Width = m.width - 4
		m.viewport.Height = m.height - headerHeight - footerHeight

		// Update chat input width
		m.chatInput.SetWidth(m.width - 8)

		m.updateViewport()

	case agentStartedMsg:
		// Agent process started successfully
		m.agentProcess = msg.process
		m.agentStdin = msg.stdin
		m.agentStdout = msg.stdout

		// Start listening to agent output
		cmds = append(cmds, m.listenToAgent())

	case agentResponseMsg:
		// Continue listening
		cmds = append(cmds, m.listenToAgent())

		switch msg.message.Type {
		case MsgResponse:
			var respData struct {
				Status  string `json:"status"`
				Message string `json:"message"`
				Content string `json:"content"`
			}
			json.Unmarshal(msg.message.Data, &respData)

			if respData.Status == "initialized" {
				m.state = StateChat
				m.agentReady = true
				m.isProcessing = false
				m.chatInput.Focus()
				m.messages = append(m.messages, ChatMessage{
					Role:      "system",
					Content:   "✓ Agent initialized successfully! You can now start by sending a message.",
					Timestamp: time.Now(),
				})
			} else if respData.Content != "" {
				// Check if we already have this content from streaming
				// If the last message is from assistant with the same content, don't duplicate
				if len(m.messages) > 0 &&
					m.messages[len(m.messages)-1].Role == "assistant" &&
					m.messages[len(m.messages)-1].Content == respData.Content {
					// Already have this content from streaming, just update processing state
					m.isProcessing = false
				} else if len(m.messages) == 0 || m.messages[len(m.messages)-1].Role != "assistant" {
					// No assistant message yet, add it
					m.messages = append(m.messages, ChatMessage{
						Role:      "assistant",
						Content:   respData.Content,
						Timestamp: time.Now(),
					})
					m.isProcessing = false
				} else {
					// Just mark as done
					m.isProcessing = false
				}
			}
			m.updateViewport()

		case MsgToolCall:
			var toolData ToolCallInfo
			json.Unmarshal(msg.message.Data, &toolData)

			// Create a concise single-line format for tool calls
			// Format: "Tool: tool_name | param1: value1, param2: value2"
			toolMsg := fmt.Sprintf("🔧 Tool: %s", toolData.ToolName)

			// Add key parameters in a compact format
			if len(toolData.Args) > 0 {
				var params []string

				// Special handling for common tools to show most relevant info
				switch toolData.ToolName {
				case "read_file", "write_file", "edit_file":
					if filePath, ok := toolData.Args["filePath"].(string); ok {
						params = append(params, fmt.Sprintf("file: %s", filePath))
					}
				case "list_files":
					if dirPath, ok := toolData.Args["dirPath"].(string); ok {
						params = append(params, fmt.Sprintf("dir: %s", dirPath))
					}
					if recursive, ok := toolData.Args["recursive"].(bool); ok && recursive {
						params = append(params, "recursive")
					}
				case "search_files":
					if pattern, ok := toolData.Args["pattern"].(string); ok {
						params = append(params, fmt.Sprintf("pattern: \"%s\"", pattern))
					}
					if dir, ok := toolData.Args["directory"].(string); ok && dir != "." {
						params = append(params, fmt.Sprintf("in: %s", dir))
					}
				case "run_command":
					if cmd, ok := toolData.Args["command"].(string); ok {
						// Truncate long commands
						if len(cmd) > 50 {
							params = append(params, fmt.Sprintf("cmd: %s...", cmd[:50]))
						} else {
							params = append(params, fmt.Sprintf("cmd: %s", cmd))
						}
					}
				case "web_search":
					if query, ok := toolData.Args["query"].(string); ok {
						params = append(params, fmt.Sprintf("query: \"%s\"", query))
					}
					if limit, ok := toolData.Args["limit"].(float64); ok && limit != 3 {
						params = append(params, fmt.Sprintf("limit: %d", int(limit)))
					}
					if scrape, ok := toolData.Args["scrape"].(bool); ok && scrape {
						params = append(params, "scrape: true")
					}
				case "url_extract":
					if url, ok := toolData.Args["url"].(string); ok {
						// Truncate long URLs
						if len(url) > 50 {
							params = append(params, fmt.Sprintf("url: %s...", url[:50]))
						} else {
							params = append(params, fmt.Sprintf("url: %s", url))
						}
					}
					if formats, ok := toolData.Args["formats"].([]interface{}); ok && len(formats) > 0 {
						formatStrs := make([]string, 0)
						for _, f := range formats {
							if fStr, ok := f.(string); ok {
								formatStrs = append(formatStrs, fStr)
							}
						}
						if len(formatStrs) > 0 {
							params = append(params, fmt.Sprintf("formats: [%s]", strings.Join(formatStrs, ",")))
						}
					}
				case "generate_unit_tests":
					if filePath, ok := toolData.Args["filePath"].(string); ok {
						params = append(params, fmt.Sprintf("file: %s", filePath))
					}
					if testFramework, ok := toolData.Args["testFramework"].(string); ok && testFramework != "testing" {
						params = append(params, fmt.Sprintf("framework: %s", testFramework))
					}
					if coverageTarget, ok := toolData.Args["coverageTarget"].(float64); ok {
						params = append(params, fmt.Sprintf("coverage: %d%%", int(coverageTarget)))
					}
				default:
					// Generic handling for unknown tools
					for key, value := range toolData.Args {
						var valueStr string
						switch v := value.(type) {
						case string:
							if len(v) > 30 {
								valueStr = fmt.Sprintf("\"%s...\"", v[:30])
							} else {
								valueStr = fmt.Sprintf("\"%s\"", v)
							}
						case bool:
							valueStr = fmt.Sprintf("%v", v)
						case float64:
							if v == float64(int(v)) {
								valueStr = fmt.Sprintf("%d", int(v))
							} else {
								valueStr = fmt.Sprintf("%v", v)
							}
						default:
							valueStr = fmt.Sprintf("%v", v)
						}
						params = append(params, fmt.Sprintf("%s: %s", key, valueStr))
					}
				}

				if len(params) > 0 {
					toolMsg += " | " + strings.Join(params, ", ")
				}
			}

			m.messages = append(m.messages, ChatMessage{
				Role:      "tool",
				Content:   toolMsg,
				Timestamp: time.Now(),
			})
			m.updateViewport()

		case MsgStreamChunk:
			var chunkData struct {
				Content string `json:"content"`
				Status  string `json:"status"`
			}
			json.Unmarshal(msg.message.Data, &chunkData)

			if chunkData.Status == "thinking" {
				// Show thinking indicator
				m.messages = append(m.messages, ChatMessage{
					Role:      "system",
					Content:   "💭 Thinking...",
					Timestamp: time.Now(),
				})
			} else if chunkData.Content != "" {
				// Update or append assistant message
				if len(m.messages) > 0 && m.messages[len(m.messages)-1].Role == "assistant" {
					m.messages[len(m.messages)-1].Content = chunkData.Content
				} else {
					m.messages = append(m.messages, ChatMessage{
						Role:      "assistant",
						Content:   chunkData.Content,
						Timestamp: time.Now(),
					})
				}
			}
			m.updateViewport()

		case MsgError:
			var errData struct {
				Message string `json:"message"`
				Details string `json:"details"`
			}
			json.Unmarshal(msg.message.Data, &errData)

			m.messages = append(m.messages, ChatMessage{
				Role:      "system",
				Content:   fmt.Sprintf("❌ Error: %s", errData.Message),
				Timestamp: time.Now(),
				IsError:   true,
			})
			m.isProcessing = false
			m.updateViewport()
		}

	case errMsg:
		m.err = msg.err
		m.isProcessing = false
		m.messages = append(m.messages, ChatMessage{
			Role:      "system",
			Content:   fmt.Sprintf("❌ System Error: %s", msg.err.Error()),
			Timestamp: time.Now(),
			IsError:   true,
		})
		m.updateViewport()
	}

	// Update sub-components
	if m.state == StateAPIKey {
		var cmd tea.Cmd
		m.apiKeyInput, cmd = m.apiKeyInput.Update(msg)
		cmds = append(cmds, cmd)
	} else if m.state == StateChat {
		var cmd tea.Cmd
		m.chatInput, cmd = m.chatInput.Update(msg)
		cmds = append(cmds, cmd)

		m.viewport, cmd = m.viewport.Update(msg)
		cmds = append(cmds, cmd)
	}

	return m, tea.Batch(cmds...)
}

func (m *Model) updateViewport() {
	var content strings.Builder

	for _, msg := range m.messages {
		timestamp := msg.Timestamp.Format("15:04:05")

		var style lipgloss.Style
		var prefix string

		switch msg.Role {
		case "user":
			style = userMsgStyle
			prefix = "You"
		case "assistant":
			style = assistantMsgStyle
			prefix = "AI"
		case "tool":
			style = toolMsgStyle
			prefix = "Tool"
		case "system":
			if msg.IsError {
				style = errorStyle
			} else {
				style = statusStyle
			}
			prefix = "System"
		}

		// Format based on role
		if msg.Role == "tool" {
			// Tool messages get a compact single-line format
			content.WriteString(fmt.Sprintf("[%s] %s\n", timestamp, toolMsgStyle.Render(msg.Content)))
		} else {
			// Regular messages with prefix and indentation
			content.WriteString(fmt.Sprintf("[%s] %s:\n", timestamp, style.Render(prefix)))

			// Wrap and indent message content
			lines := strings.Split(msg.Content, "\n")
			for _, line := range lines {
				content.WriteString(fmt.Sprintf("  %s\n", line))
			}
		}
		content.WriteString("\n")
	}

	m.viewport.SetContent(content.String())
	m.viewport.GotoBottom()
}

func (m Model) View() string {
	if m.width == 0 {
		return "Initializing..."
	}

	var content string

	switch m.state {
	case StateAPIKey:
		title := titleStyle.Render("🚀 Keploy Agent")

		prompt := "Google API key:"
		if m.isProcessing {
			prompt = "Initializing agent..."
		}

		input := inputStyle.Render(m.apiKeyInput.View())

		help := helpStyle.Render("\nPress Enter to continue • Ctrl+C to quit")

		content = lipgloss.JoinVertical(
			lipgloss.Left,
			title,
			"",
			prompt,
			input,
			help,
		)

		if m.err != nil {
			content += "\n\n" + errorStyle.Render(fmt.Sprintf("Error: %v", m.err))
		}

	case StateChat:
		title := titleStyle.Render("💬 Keploy Assistant")

		status := statusStyle.Render(fmt.Sprintf("Connected • %d messages", len(m.messages)))
		if m.isProcessing {
			status = statusStyle.Render("Processing... 🔄")
		}

		header := lipgloss.JoinHorizontal(
			lipgloss.Left,
			title,
			strings.Repeat(" ", 10),
			status,
		)

		chatHistory := m.viewport.View()

		inputLabel := "Message:"
		if m.isProcessing {
			inputLabel = "Waiting for response..."
		}

		chatInputView := lipgloss.JoinVertical(
			lipgloss.Left,
			inputLabel,
			inputStyle.Render(m.chatInput.View()),
		)

		help := helpStyle.Render("Ctrl+S to send • Ctrl+C to quit")

		content = lipgloss.JoinVertical(
			lipgloss.Left,
			header,
			chatHistory,
			chatInputView,
			help,
		)
	}

	return appStyle.Render(content)
}

func main() {
	// Set up logging - try to create log file but don't fail if we can't
	homeDir, _ := os.UserHomeDir()
	logPath := filepath.Join(homeDir, ".local", "lib", "keploy-agent", "keploy-agent.log")
	logFile, err := os.Create(logPath)
	if err == nil {
		log.SetOutput(logFile)
		defer logFile.Close()
	} else {
		// If we can't create the log file, just log to stderr
		log.SetOutput(os.Stderr)
	}

	// Create and run the Keploy Agent
	p := tea.NewProgram(initialModel(), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error running Keploy Agent: %v\n", err)
		os.Exit(1)
	}
}
