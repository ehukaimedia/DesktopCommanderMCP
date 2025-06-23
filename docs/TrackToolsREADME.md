# TrackTools Enhanced Logging Engine

> Technical documentation for the intelligent intent detection system in DesktopCommanderMCP-Recap

## Overview

The `trackTools.ts` module transforms basic tool call logging into an intelligent development assistant that understands user intentions through sophisticated pattern analysis. This enhancement maintains 100% backward compatibility while adding revolutionary intent detection capabilities.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Core Interfaces](#core-interfaces)
- [Intent Detection Algorithms](#intent-detection-algorithms)
- [Context Management](#context-management)
- [Session Management](#session-management)
- [Enhanced Log Format](#enhanced-log-format)
- [Integration Guide](#integration-guide)
- [Performance Considerations](#performance-considerations)
- [Testing & Validation](#testing--validation)
- [Troubleshooting](#troubleshooting)

## Architecture Overview

### Core Components

```typescript
trackToolCall(toolName: string, args?: unknown): Promise<void>
```

The main entry point that:
1. **Session Management** - Detects new sessions based on 15-minute timeout
2. **Context Accumulation** - Builds recent args, files, and tool sequences
3. **Pattern Analysis** - Runs intent detection when sufficient context exists (2+ tools)
4. **Enhanced Logging** - Outputs contextual information with intent data
5. **File Rotation** - Manages log file size with automatic rotation

### Processing Pipeline

```
Tool Call → Context Update → Pattern Analysis → Intent Detection → Enhanced Logging
     ↓              ↓               ↓               ↓              ↓
  Session      File/Args      Algorithm       Confidence    JSON Output
  Tracking     Tracking       Execution       Scoring       with Intent
```

## Core Interfaces

### IntentSignals

```typescript
interface IntentSignals {
  trigger: 'error_response' | 'exploration' | 'planned_work' | 'maintenance';
  confidence: number; // 0-1 confidence score
  evidence: string[]; // What led to this conclusion
  likely_goal: string; // Inferred purpose
  category: 'reactive' | 'proactive' | 'investigative' | 'maintenance';
}
```

### ContextState

```typescript
interface ContextState {
  lastCallTime?: Date;
  sessionId?: string;
  currentWorkingDir?: string;
  recentFiles: string[];
  toolSequence: string[];
  sessionStartTime?: Date;
  recentSearches: SearchOperation[];
  searchContext: Map<string, string>;
  lastEdit?: EditContext;
  
  // Intent detection fields
  recentArgs: any[];
  intentSignals: IntentSignals[];
  workPattern: 'reactive' | 'proactive' | 'investigative' | 'maintenance';
}
```

### SearchOperation

```typescript
interface SearchOperation {
  toolName: string;
  query: string;
  path: string;
  timestamp: Date;
  resultsCount?: number;
  success: boolean;
  intent?: string;
}
```

## Intent Detection Algorithms

### 1. Error-Driven Detection

**Purpose**: Identifies debugging workflows triggered by errors, test failures, or investigation of undefined behavior.

**Algorithm**:
```typescript
function detectErrorDrivenWork(
  toolSequence: string[], 
  recentArgs: any[], 
  recentFiles: string[], 
  recentExecutions: Array<{command: string, timestamp: Date}>
): IntentSignals | null
```

**Detection Criteria**:
- Error keywords in search: `+0.3` per term (`error`, `bug`, `fail`, `undefined`, `null`, `exception`, `crash`, `broken`)
- Debugging workflow sequence: `+0.25` (`search_code → read_file → edit_block`)
- Test/log file access: `+0.15`
- Recent test commands: `+0.2`
- **Threshold**: `0.25` minimum confidence

**Example Pattern**:
```typescript
// Sequence: search_code("undefined") → read_file("test.js") → edit_block(...)
// Result: { confidence: 0.75, likely_goal: "Debug and fix identified error", category: "reactive" }
```

### 2. Planned Development Detection

**Purpose**: Recognizes systematic feature implementation through type definitions, file creation patterns, and organized development approaches.

**Algorithm**:
```typescript
function detectPlannedDevelopment(
  toolSequence: string[], 
  recentArgs: any[], 
  recentFiles: string[], 
  recentExecutions: Array<{command: string, timestamp: Date}>
): IntentSignals | null
```

**Detection Criteria**:
- Type definition work: `+0.3` (`.d.ts`, `interface`, `types.`)
- File/directory creation: `+0.25` (`create_directory`, `write_file`)
- Multi-file-type systematic work: `+0.2` (≥2 different file extensions)
- Configuration changes: `+0.15` (`config`, `package.json`, `tsconfig`)
- **Threshold**: `0.25` minimum confidence

**Example Pattern**:
```typescript
// Sequence: create_directory → write_file("types.ts") → write_file("component.tsx")
// Result: { confidence: 0.68, likely_goal: "Implement new feature following planned approach", category: "proactive" }
```

### 3. Exploratory Investigation Detection

**Purpose**: Detects learning and discovery activities via read patterns without immediate editing.

**Algorithm**:
```typescript
function detectExploratoryWork(
  toolSequence: string[], 
  recentArgs: any[], 
  recentFiles: string[], 
  recentExecutions: Array<{command: string, timestamp: Date}>
): IntentSignals | null
```

**Detection Criteria**:
- High read-to-edit ratio: `+0.3` (≥3 reads, ≤1 edit)
- Directory traversal patterns: `+0.25` (≥2 `list_directory`)
- Multiple search operations: `+0.2` (≥2 search operations)
- Diverse file access: `+0.15` (≥4 files accessed)
- **Threshold**: `0.25` minimum confidence

**Example Pattern**:
```typescript
// Sequence: list_directory → read_file → read_file → search_files
// Result: { confidence: 0.62, likely_goal: "Understand codebase structure", category: "investigative" }
```

### 4. Maintenance Work Detection

**Purpose**: Spots refactoring and optimization through edit patterns and configuration work.

**Algorithm**:
```typescript
function detectMaintenanceWork(
  toolSequence: string[], 
  recentArgs: any[], 
  recentFiles: string[], 
  recentExecutions: Array<{command: string, timestamp: Date}>
): IntentSignals | null
```

**Detection Criteria**:
- Multiple small edits: `+0.3` (≥3 `edit_block` operations)
- Dependency/package work: `+0.25` (`package.json`, `yarn.lock`, `node_modules`)
- Config file modifications: `+0.2` (`.json`, `.yml`, `.yaml`, `config`)
- Build/test commands: `+0.15` (`build`, `npm`, `yarn`)
- **Threshold**: `0.25` minimum confidence

**Example Pattern**:
```typescript
// Sequence: edit_block → edit_block → execute_command("npm build")
// Result: { confidence: 0.58, likely_goal: "Perform maintenance tasks", category: "maintenance" }
```

## Context Management

### Session Detection

Sessions are automatically detected with a 15-minute timeout:

```typescript
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

if (!contextState.lastCallTime || 
    (now - contextState.lastCallTime.getTime()) > SESSION_TIMEOUT_MS) {
  // Start new session
  contextState.sessionId = generateSessionId();
  contextState.sessionStartTime = timestamp;
  // Reset context for new session
}
```

### Context Accumulation

The system maintains rolling context windows:

```typescript
const MAX_RECENT_FILES = 10;
const MAX_TOOL_SEQUENCE = 5;
const MAX_RECENT_SEARCHES = 20;
const MAX_INTENT_SIGNALS = 5;
const MAX_RECENT_ARGS = 15;
```

### Working Directory Detection

```typescript
function extractWorkingDirectory(args: any): string | undefined {
  const pathFields = ['path', 'file_path', 'source', 'destination'];
  // Extract from first valid absolute path found
}
```

## Enhanced Log Format

### Standard Entry Structure

```json
{
  "timestamp": "2025-06-22T20:42:38.692Z",
  "tool": "search_code",
  "context": {
    "session": "mc84wf6s_u7w54r",
    "sessionAge": "15m",
    "newSession": false,
    "project": "E-commerce API",
    "workflow": "DEBUGGING",
    "sequence": "search_code→read_file→edit_block",
    "files": ["server.js"],
    "currentTask": "Debugging and fixing code based on search results"
  },
  "args": {
    "pattern": "undefined",
    "path": "./src"
  }
}
```

### Enhanced Entry with Intent

```json
{
  "timestamp": "2025-06-22T20:42:38.692Z",
  "tool": "edit_block",
  "context": {
    "session": "mc84wf6s_u7w54r",
    "sessionAge": "18m",
    "project": "E-commerce API",
    "workflow": "DEBUGGING",
    "intent": "Debug and fix identified error or test failure",
    "intentConfidence": 75,
    "workPattern": "reactive",
    "intentEvidence": [
      "Error-related search term: \"undefined\"",
      "Working with test files or logs",
      "Debugging workflow: search → read → edit"
    ],
    "files": ["server.js"],
    "lastEdit": {
      "file": "server.js",
      "editType": "modify",
      "purpose": "Code modification"
    }
  },
  "args": {
    "file_path": "./src/server.js",
    "old_string": "const result = data.user.name;",
    "new_string": "const result = data.user?.name || 'Unknown';"
  }
}
```

## Integration Guide

### Basic Integration

```typescript
import { trackToolCall } from './utils/trackTools.js';

// In your tool execution function
async function myTool(args: ToolArgs): Promise<ToolResult> {
  // Track the tool call with intent detection
  await trackToolCall('myTool', args);
  
  // Your existing tool logic
  const result = performToolOperation(args);
  
  return result;
}
```

### Server Integration Example

```typescript
// In server.ts
import { trackToolCall } from './utils/trackTools.js';

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Enhanced logging with intent detection
  await trackToolCall(request.params.name, request.params.arguments);
  
  // Existing tool execution logic
  return await executeTool(request.params.name, request.params.arguments);
});
```

### Configuration

Environment variables for customization:

```bash
# Override log file location
RECAP_LOG_PATH="/custom/path/logs/tool_calls.log"

# Maximum sessions to analyze (default: 50)
RECAP_MAX_SESSIONS=100

# Analysis timeout in milliseconds (default: 30000)
RECAP_TIMEOUT=45000
```

## Performance Considerations

### Memory Usage

The context state maintains bounded collections:

```typescript
// Automatic cleanup when limits exceeded
if (contextState.recentFiles.length > MAX_RECENT_FILES) {
  contextState.recentFiles.shift();
}
```

### CPU Impact

- **Intent detection**: Only runs when ≥2 tool calls in sequence
- **Pattern analysis**: O(n) where n is size of context windows
- **File operations**: Asynchronous to avoid blocking

### File I/O Optimization

- **Append-only writes**: Minimal disk I/O overhead
- **Automatic rotation**: Prevents unlimited file growth
- **Error isolation**: Logging failures don't break tool execution

```typescript
// File size management
if (fileSize >= TOOL_CALL_FILE_MAX_SIZE) {
  const rotateTimestamp = generateTimestamp();
  await fs.promises.rename(TOOL_CALL_FILE, `${fileBase}_${rotateTimestamp}${fileExt}`);
}
```

## Testing & Validation

### Intent Detection Tests

Create test scenarios for each algorithm:

```javascript
// Test error-driven detection
const testErrorDriven = {
  toolSequence: ['search_code', 'read_file', 'edit_block'],
  recentArgs: [
    { pattern: 'undefined', path: './src' },
    { path: './src/test.js' },
    { file_path: './src/test.js', old_string: 'bug', new_string: 'fix' }
  ],
  recentFiles: ['./src/test.js'],
  expected: {
    trigger: 'error_response',
    confidence: '>= 0.5',
    category: 'reactive'
  }
};
```

### Validation Script

```bash
cd /path/to/DesktopCommanderMCP-Recap
node tests/intent-detection-validation.cjs
```

Expected output:
```
✅ Error-driven detection: PASS (confidence: 75%)
✅ Planned development detection: PASS (confidence: 68%)
✅ Exploratory investigation detection: PASS (confidence: 62%)
✅ Maintenance work detection: PASS (confidence: 58%)
```

## Troubleshooting

### Common Issues

**1. Intent detection not triggering**
```typescript
// Check context accumulation
console.log('Tool sequence:', contextState.toolSequence);
console.log('Recent args count:', contextState.recentArgs.length);
// Requires: toolSequence.length >= 2 AND confidence >= 0.25
```

**2. Low confidence scores**
```typescript
// Increase pattern evidence
const moreEvidence = [
  'Add error keywords to search terms',
  'Use systematic file creation patterns',
  'Include multiple file types in work',
  'Perform debugging sequence: search → read → edit'
];
```

**3. Session not persisting**
```typescript
// Check session timeout
const timeSinceLastCall = now - contextState.lastCallTime.getTime();
if (timeSinceLastCall > SESSION_TIMEOUT_MS) {
  console.log('Session expired, starting new session');
}
```

### Debug Logging

Enable detailed logging:

```typescript
// Add to trackToolCall function
console.log('Intent detection result:', intentSignal);
console.log('Context state:', contextState);
console.log('Recent args:', contextState.recentArgs);
```

### Log File Issues

**Location verification**:
```bash
# Default location
ls -la ~/.claude-server-commander/claude_tool_call.log

# Custom location (if RECAP_LOG_PATH set)
ls -la $RECAP_LOG_PATH
```

**Format validation**:
```bash
# Check for enhanced format
tail -n 5 ~/.claude-server-commander/claude_tool_call.log | jq '.context.intent'
```

## API Reference

### Main Function

```typescript
trackToolCall(toolName: string, args?: unknown): Promise<void>
```

**Parameters**:
- `toolName` (string): Name of the tool being called
- `args` (unknown, optional): Arguments passed to the tool

**Returns**: Promise<void> - Async operation, logs enhanced data to file

**Throws**: Captures errors internally, does not throw to avoid breaking tool execution

### Utility Functions

```typescript
generateSessionId(): string
extractWorkingDirectory(args: any): string | undefined
extractFilePaths(args: any): string[]
detectWorkflowPattern(toolSequence: string[]): string | undefined
getProjectName(workingDir: string): string | undefined
```

### Intent Detection Functions

```typescript
detectErrorDrivenWork(...): IntentSignals | null
detectPlannedDevelopment(...): IntentSignals | null
detectExploratoryWork(...): IntentSignals | null
detectMaintenanceWork(...): IntentSignals | null
detectIntentSignals(...): IntentSignals | null
```

## Constants

```typescript
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_RECENT_FILES = 10;
const MAX_TOOL_SEQUENCE = 5;
const MAX_RECENT_SEARCHES = 20;
const MAX_INTENT_SIGNALS = 5;
const MAX_RECENT_ARGS = 15;
const INTENT_CONFIDENCE_THRESHOLD = 0.35;
```

## Version History

### v2.0.0 - Revolutionary Intent Detection
- Added 4-algorithm intent detection system
- Enhanced context state management
- Evidence-based confidence scoring
- Session-aware pattern analysis
- Backward-compatible enhanced logging

### v1.0.0 - Basic Tool Tracking
- Simple tool call logging
- Basic session detection
- File path extraction
- Workflow pattern recognition

## Contributing

To contribute to the intent detection system:

1. **Fork the repository**
2. **Study the algorithm implementations** in `trackTools.ts`
3. **Add test cases** for new patterns in `tests/`
4. **Validate changes** with intent detection tests
5. **Submit pull request** with detailed documentation

### Development Guidelines

- Maintain backward compatibility
- Add comprehensive test coverage
- Document algorithm changes
- Preserve confidence scoring accuracy
- Ensure evidence transparency

---

**Technical documentation for the intelligent tracking engine that powers DesktopCommanderMCP-Recap's revolutionary intent detection capabilities.**

*Last updated: June 22, 2025*
