# Pi in Chrome (`pi-in-chrome`)

> 🚀 **Reverse-engineered from Claude Code's built-in Chrome extension (`claude-in-chrome`)**, completely replicated as a native extension for the **Pi Coding Agent (`@earendil-works/pi-coding-agent`)** paired with an **unrestricted standalone Chrome MV3 browser automation extension**.

**Author**: ZheNing Hu ([adlternative@gmail.com](mailto:adlternative@gmail.com))  
**License**: MIT  

---

## 📖 Architecture & Reverse Engineering Background

Through deep reverse engineering (REA) and AST static auditing of the Claude Code CLI binary (`claude.exe`) and the official Chrome extension (`fcoeoabgfenejglbffodgkkbkcdhcgfn`), we reconstructed the native browser automation bridge and completely eliminated all official cloud restrictions:

```mermaid
flowchart TD
    subgraph PiAgent["Pi Coding Agent (@earendil-works/pi-coding-agent)"]
        Tools["20 Browser MCP Tools\n(mcp__claude-in-chrome__*)"]
        LocalModel["🧠 Local Pi LLM (Ollama / DeepSeek / Private Models)\nPerforms 100% of reasoning & element matching"]
        Exec["Automation Pipeline (ChromeExecutionManager)\n- Local file upload to Base64 (<=10MB)\n- Screenshot save_to_disk support"]
        Pool["Multi-Instance SocketPool\n- Scans /tmp/pi-mcp-browser-bridge-* & /tmp/claude-mcp-browser-bridge-*\n- Aggregates availableTabs & routes via tabId"]
        LocalModel --> PiAgent
        Tools --> Exec --> Pool
    end

    subgraph NativeHosts["Chrome Native Messaging Host"]
        NH["~/.claude/chrome/chrome-native-host\n(Executes bin/native-host.mjs)"]
        NHManifest1["com.pi.chrome_browser_extension.json"]
        NHManifest2["com.anthropic.claude_code_browser_extension.json"]
        NHManifest1 -.-> NH
        NHManifest2 -.-> NH
    end

    subgraph Chrome["Google Chrome Browser"]
        Ext["Standalone Extension (Pi in Chrome)\nID: jlgmmfgplddjhfbfhnohfnjhdbpnalka\n- 0 Cloud Network Requests\n- 0 Permission Popups or 30s Timeouts\n- 0 Sensitive Field Redactions\n- Dedicated Pi Tab Group Sandbox"]
        DOM["Web Page DOM (Including http://localhost:3000)\n- accessibility-tree.js generates ref_X\n- agent-visual-indicator.js frame states"]
        Ext --> DOM
    end

    Pool <-->|"4-Byte UInt32LE + JSON (Unix Domain Socket)"| NH
    NH <-->|"stdio (4-Byte UInt32LE + JSON)"| Ext
```

---

## 🌟 Comparison & Unrestricted Features

| Feature | Official Claude Extension (`fcoeoabgfenejglbffodgkkbkcdhcgfn`) | Standalone Replicated Extension (`Pi in Chrome`) |
| :--- | :--- | :--- |
| **URL Safety Checks** | Cloud `url_hash_check` fails on offline / `localhost` apps | **Local Always-Pass (`category0`)**: Zero external requests, full support for `localhost:3000` |
| **Permission Popups** | Opens 600×600 popup; fails with 30s timeout if unclicked | **Zero Popups**: Automated actions pass without modal interruption |
| **JS Content Redaction** | Replaces `author` fields, URL parameters, Base64 with `[BLOCKED]` | **100% Raw Data**: No destructive modifications or censoring |
| **Tab Group Isolation** | Confined strictly to yellow Claude group | **Dedicated `Pi` Tab Group Sandbox**: Protects user personal tabs while allowing drag-in adoption |
| **Element Search Inference** | Secretly sends page DOM to Anthropic Cloud Claude API | **100% Local Inference**: Uses your local Pi model directly, zero data leakage |
| **Account & Login** | Force redirects to `claude.ai/oauth/authorize` on install | **Pure Standalone**: Zero third-party account or API token requirements |
| **Auto-Reconnect** | Stops permanently on socket disconnect | **Self-Healing**: 3-second heartbeat and `chrome.alarms` background reconnect |

---

## 🛠 Complete 20-Tool MCP Browser Suite

1. **Page Structure & Text Extraction**:
   - `read_page`: Extract structured accessibility tree with unique `[ref_X]` identifiers.
   - `get_page_text`: Extract clean reader-friendly text from article contents.
   - `find`: Natural language element locator with fast local token scoring.
2. **CDP Physical Mouse & Keyboard Emulation**:
   - `computer`: (`click`, `mouse_down`, `mouse_up`, `right_click`, `double_click`, `triple_click`, `middle_click`, `drag`, `scroll_at`, `type`, `key_down`, `key_up`, `key_press`, `zoom`, `screenshot`).
   - `form_input`: Form control typing and value binding.
3. **Navigation & Execution**:
   - `navigate`: Navigate to URL, forward, or backward in history.
   - `javascript_tool`: Execute JavaScript expressions directly in page context and receive raw outputs.
   - `file_upload` / `upload_image`: Inject local files into file inputs automatically as Base64 payloads.
4. **Diagnostic & Monitoring**:
   - `read_console_messages`: Capture console logs (`log`, `warn`, `error`) and stack traces in real time.
   - `read_network_requests`: Inspect active network requests and HTTP responses.
5. **Tab Management & Batching**:
   - `tabs_context_mcp` / `tabs_create_mcp` / `tabs_close_mcp`: Tab lifecycle and sandboxed group discovery.
   - `browser_batch`: Sequence multiple actions in one round-trip (dramatically accelerates multi-step tasks).

---

## 🚀 Quick Setup (1 Minute)

### Step 1: Install Native Messaging Host Manifests
Run the setup script inside this project:
```bash
npm run setup
```
This automatically registers the Native Messaging Host manifests for all installed Chromium browsers (Google Chrome, Brave, Arc, Microsoft Edge, Chromium, Vivaldi, Opera).

### Step 2: Load Unpacked Chrome Extension
1. Open `chrome://extensions` in Google Chrome (or Edge/Brave/Arc).
2. Toggle on **"Developer mode"** in the top-right corner.
3. Click **"Load unpacked"** in the top-left corner.
4. Select the directory:
   ```
   pi-in-chrome/chrome-extension
   ```
5. The extension (`Pi`) will load with deterministic ID `jlgmmfgplddjhfbfhnohfnjhdbpnalka` and the official Pi geometric logo.

---

## 💻 Usage with Pi Coding Agent

### Automatic Global Loading (Recommended)
Place an extension loader in `~/.pi/agent/extensions/pi-chrome.ts`:
```typescript
import extension from "/path/to/pi-in-chrome/src/index.ts";
export default extension;
```
Once added, launch `pi` in any directory to automatically enable all browser automation capabilities:

```bash
# Start interactive Pi session
pi
```

You can prompt Pi naturally:
* *"Open http://localhost:3000 and check if the homepage renders without errors"*
* *"Click the submit button in the current tab"*
* *"Take a screenshot of the page and inspect the layout"*

### Non-Interactive Single-Shot Execution
```bash
pi -p "Open http://localhost:3000 using the browser and tell me the page title"
```

### Dedicated Slash Commands
- `/chrome status`: View socket connection status, active bridges, and open tabs.
- `/chrome tabs`: List all tabs currently managed inside the Pi sandbox group.
- `/chrome reconnect`: Force scan and reconnect to active browser sockets.
- `/chrome enable` / `/chrome disable`: Toggle browser tool availability for the current session.

---

## 🧪 Automated End-to-End Testing

Run the live test suite to verify connectivity and tool execution with your running Chrome instance:
```bash
npm test
```
The test verifies `tabs_context_mcp`, `read_page`, `javascript_tool`, and `read_console_messages` in real time.
