import * as fs from 'fs';
import * as path from 'path';
import { TOOL_CALL_FILE, TOOL_CALL_FILE_MAX_SIZE } from '../config.js';

// Ensure the directory for the log file exists
const logDir = path.dirname(TOOL_CALL_FILE);
await fs.promises.mkdir(logDir, { recursive: true });

// Session and context tracking
interface SearchOperation {
  toolName: string;
  query: string;
  path: string;
  timestamp: Date;
  resultsCount?: number;
  success: boolean;
  intent?: string;
}

interface ContextState {
  lastCallTime?: Date;
  sessionId?: string;
  currentWorkingDir?: string;
  recentFiles: string[];
  toolSequence: string[];
  sessionStartTime?: Date;
  recentSearches: SearchOperation[];
  searchContext: Map<string, string>; // file -> reason for access
}

let contextState: ContextState = {
  recentFiles: [],
  toolSequence: [],
  recentSearches: [],
  searchContext: new Map()
};

// Session timeout (15 minutes of inactivity starts new session)
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

// Maximum items to track for context
const MAX_RECENT_FILES = 10;
const MAX_TOOL_SEQUENCE = 5;
const MAX_RECENT_SEARCHES = 20;

/**
 * Generate a simple session ID
 */
function generateSessionId(): string {
  const now = new Date();
  const timestamp = now.getTime().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}_${random}`;
}

/**
 * Extract working directory from file paths in arguments
 */
function extractWorkingDirectory(args: any): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  
  // Look for path arguments
  const pathFields = ['path', 'file_path', 'source', 'destination'];
  for (const field of pathFields) {
    if (args[field] && typeof args[field] === 'string') {
      const filePath = args[field];
      if (path.isAbsolute(filePath)) {
        return path.dirname(filePath);
      }
    }
  }
  
  // Handle arrays of paths (like read_multiple_files)
  if (args.paths && Array.isArray(args.paths) && args.paths.length > 0) {
    const firstPath = args.paths[0];
    if (typeof firstPath === 'string' && path.isAbsolute(firstPath)) {
      return path.dirname(firstPath);
    }
  }
  
  return undefined;
}

/**
 * Extract file paths from arguments for tracking
 */
function extractFilePaths(args: any): string[] {
  if (!args || typeof args !== 'object') return [];
  
  const paths: string[] = [];
  const pathFields = ['path', 'file_path', 'source', 'destination'];
  
  for (const field of pathFields) {
    if (args[field] && typeof args[field] === 'string') {
      paths.push(args[field]);
    }
  }
  
  if (args.paths && Array.isArray(args.paths)) {
    paths.push(...args.paths.filter((p: any) => typeof p === 'string'));
  }
  
  return paths;
}

/**
 * Detect workflow patterns based on tool sequence
 */
function detectWorkflowPattern(toolSequence: string[]): string | undefined {
  const sequence = toolSequence.join(' → ');
  
  // Common patterns
  if (sequence.includes('read_file → edit_block')) return 'EDITING';
  if (sequence.includes('list_directory → read_file')) return 'EXPLORATION';
  if (sequence.includes('search_code → read_file')) return 'DEBUGGING';
  if (sequence.includes('create_directory → write_file')) return 'SETUP';
  if (sequence.includes('read_multiple_files')) return 'ANALYSIS';
  if (sequence.includes('execute_command')) return 'EXECUTION';
  
  return undefined;
}

/**
 * Get project name from working directory
 */
function getProjectName(workingDir: string): string | undefined {
  if (!workingDir) return undefined;
  
  const parts = workingDir.split(path.sep);
  // Look for common project indicators
  const projectIndicators = ['Desktop', 'Documents', 'Projects', 'Code', 'src', 'workspace'];
  
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part && !projectIndicators.includes(part) && part !== '') {
      return part;
    }
  }
  
  return parts[parts.length - 1] || undefined;
}

/**
 * Capture search operation context
 */
function captureSearchOperation(toolName: string, args: any, timestamp: Date): SearchOperation | null {
  if (!['search_files', 'search_code'].includes(toolName)) {
    return null;
  }
  
  const searchOp: SearchOperation = {
    toolName,
    query: '',
    path: '',
    timestamp,
    success: false
  };
  
  if (toolName === 'search_files' && args) {
    searchOp.query = args.pattern || '';
    searchOp.path = args.path || '';
    searchOp.intent = `Searching for files matching "${searchOp.query}"`;
  } else if (toolName === 'search_code' && args) {
    searchOp.query = args.pattern || '';
    searchOp.path = args.path || '';
    searchOp.intent = `Searching code for pattern "${searchOp.query}"`;
  }
  
  return searchOp;
}

/**
 * Update search operation with results
 */
function updateSearchResults(searchOp: SearchOperation, success: boolean, resultsCount?: number): void {
  searchOp.success = success;
  searchOp.resultsCount = resultsCount;
  
  // Track in recent searches
  contextState.recentSearches.push(searchOp);
  if (contextState.recentSearches.length > MAX_RECENT_SEARCHES) {
    contextState.recentSearches.shift();
  }
}

/**
 * Track tool calls and save them to a log file with contextual information
 * @param toolName Name of the tool being called
 * @param args Arguments passed to the tool (optional)
 */
export async function trackToolCall(toolName: string, args?: unknown): Promise<void> {
  try {
    const timestamp = new Date();
    const now = timestamp.getTime();
    
    // Determine if this is a new session
    let isNewSession = false;
    if (!contextState.lastCallTime || !contextState.sessionId) {
      isNewSession = true;
    } else {
      const timeSinceLastCall = now - contextState.lastCallTime.getTime();
      if (timeSinceLastCall > SESSION_TIMEOUT_MS) {
        isNewSession = true;
      }
    }
    
    // Start new session if needed
    if (isNewSession) {
      contextState.sessionId = generateSessionId();
      contextState.sessionStartTime = timestamp;
      contextState.recentFiles = [];
      contextState.toolSequence = [];
      contextState.recentSearches = [];
      contextState.searchContext.clear();
    }
    
    // Update context state
    contextState.lastCallTime = timestamp;
    
    // Track tool sequence (keep last N tools)
    contextState.toolSequence.push(toolName);
    if (contextState.toolSequence.length > MAX_TOOL_SEQUENCE) {
      contextState.toolSequence.shift();
    }
    
    // Capture search operations for enhanced context
    const searchOp = captureSearchOperation(toolName, args, timestamp);
    if (searchOp) {
      // For now, mark as successful - would need result feedback for accuracy
      updateSearchResults(searchOp, true, 0);
    }
    
    // Extract and update working directory
    const workingDir = extractWorkingDirectory(args);
    if (workingDir) {
      contextState.currentWorkingDir = workingDir;
    }
    
    // Track files being worked on
    const filePaths = extractFilePaths(args);
    for (const filePath of filePaths) {
      if (!contextState.recentFiles.includes(filePath)) {
        contextState.recentFiles.push(filePath);
        if (contextState.recentFiles.length > MAX_RECENT_FILES) {
          contextState.recentFiles.shift();
        }
      }
    }
    
    // Build contextual information
    const timeSinceSessionStart = contextState.sessionStartTime 
      ? Math.round((now - contextState.sessionStartTime.getTime()) / 1000 / 60) // minutes
      : 0;
    
    const workflowPattern = detectWorkflowPattern(contextState.toolSequence);
    const projectName = getProjectName(contextState.currentWorkingDir || '');
    
    // Build contextual log entry
    const contextInfo: any = {
      session: contextState.sessionId,
      sessionAge: `${timeSinceSessionStart}m`,
    };
    
    if (isNewSession) {
      contextInfo.newSession = true;
    }
    
    if (projectName) {
      contextInfo.project = projectName;
    }
    
    if (workflowPattern) {
      contextInfo.workflow = workflowPattern;
    }
    
    if (contextState.toolSequence.length > 1) {
      contextInfo.sequence = contextState.toolSequence.slice(-3).join('→');
    }
    
    if (filePaths.length > 0) {
      contextInfo.files = filePaths.map(f => path.basename(f));
    }
    
    // Add search context if available
    if (contextState.recentSearches.length > 0) {
      const recentSearch = contextState.recentSearches[contextState.recentSearches.length - 1];
      if (recentSearch.timestamp.getTime() === timestamp.getTime()) {
        contextInfo.searchQuery = recentSearch.query;
        contextInfo.searchIntent = recentSearch.intent;
      }
    }
    
    // Add recent search summary
    if (contextState.recentSearches.length > 0) {
      const searchSummary = contextState.recentSearches.slice(-3).map(s => 
        `${s.toolName}:"${s.query}"`
      ).join(', ');
      contextInfo.recentSearches = searchSummary;
    }
    
    // Format the enhanced log entry
    const argsJson = args ? JSON.stringify(args) : '';
    const contextJson = JSON.stringify(contextInfo);
    
    const logEntry = `${timestamp.toISOString()} | ${toolName.padEnd(20, ' ')} | ${contextJson}${argsJson ? ` | Args: ${argsJson}` : ''}\n`;

    // File rotation logic (same as original)
    let fileSize = 0;
    try {
      const stats = await fs.promises.stat(TOOL_CALL_FILE);
      fileSize = stats.size;
    } catch (err) {
      // File doesn't exist yet, size remains 0
    }
    
    if (fileSize >= TOOL_CALL_FILE_MAX_SIZE) {
      const fileExt = path.extname(TOOL_CALL_FILE);
      const fileBase = path.basename(TOOL_CALL_FILE, fileExt);
      const dirName = path.dirname(TOOL_CALL_FILE);
      
      const date = new Date();
      const rotateTimestamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}-${String(date.getSeconds()).padStart(2, '0')}`;
      const newFileName = path.join(dirName, `${fileBase}_${rotateTimestamp}${fileExt}`);
      
      await fs.promises.rename(TOOL_CALL_FILE, newFileName);
    }
    
    // Append to log file
    await fs.promises.appendFile(TOOL_CALL_FILE, logEntry, 'utf8');
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const { capture } = await import('./capture.js');
        
    await capture('server_track_tool_call_error', {
      error: errorMessage,
      toolName
    });    
    console.error(`Error logging tool call: ${error instanceof Error ? error.message : String(error)}`);
  }
}