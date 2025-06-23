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

interface EditContext {
  file: string;
  lineNumber?: number;
  functionName?: string;
  editType: 'create' | 'modify' | 'delete';
  purpose: string;
}

interface IntentSignals {
  trigger: 'error_response' | 'exploration' | 'planned_work' | 'maintenance';
  confidence: number; // 0-1 confidence score
  evidence: string[]; // What led to this conclusion
  likely_goal: string; // Inferred purpose
  category: 'reactive' | 'proactive' | 'investigative' | 'maintenance';
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
  lastEdit?: EditContext; // Most recent edit operation
  // Intent detection fields - THIS FIXES THE ROOT CAUSE
  recentArgs: any[]; // Store recent arguments for pattern analysis
  intentSignals: IntentSignals[];
  workPattern: 'reactive' | 'proactive' | 'investigative' | 'maintenance';
}

let contextState: ContextState = {
  recentFiles: [],
  toolSequence: [],
  recentSearches: [],
  searchContext: new Map(),
  // Intent detection state
  recentArgs: [],
  intentSignals: [],
  workPattern: 'proactive'
};

// Session timeout (15 minutes of inactivity starts new session)
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

// Maximum items to track for context
const MAX_RECENT_FILES = 10;
const MAX_TOOL_SEQUENCE = 5;
const MAX_RECENT_SEARCHES = 20;

// Intent detection constants
const MAX_INTENT_SIGNALS = 5;
const MAX_RECENT_ARGS = 15;
const INTENT_CONFIDENCE_THRESHOLD = 0.35;

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
 * Extract edit context from tool operations
 */
function extractEditLocation(toolName: string, args: any): EditContext | null {
  if (toolName === 'edit_block' && args) {
    return {
      file: args.file_path || '',
      editType: 'modify',
      purpose: inferEditPurpose(args.old_string, args.new_string)
    };
  }
  
  if (toolName === 'write_file' && args) {
    return {
      file: args.path || '',
      editType: args.mode === 'append' ? 'modify' : 'create',
      purpose: 'File creation/modification'
    };
  }
  
  return null;
}

/**
 * Infer edit purpose from content changes
 */
function inferEditPurpose(oldString?: string, newString?: string): string {
  if (!oldString || !newString) return 'Content modification';
  
  if (newString.includes('interface') && !oldString.includes('interface')) {
    return 'Adding interface definition';
  }
  if (newString.includes('function') && !oldString.includes('function')) {
    return 'Adding function implementation';
  }
  if (newString.includes('import') && !oldString.includes('import')) {
    return 'Adding import statement';
  }
  if (newString.length > oldString.length * 1.5) {
    return 'Expanding functionality';
  }
  if (newString.length < oldString.length * 0.5) {
    return 'Refactoring/simplifying code';
  }
  
  return 'Code modification';
}

/**
 * Infer current task from tool sequence and context
 */
function inferCurrentTask(toolSequence: string[], recentFiles: string[]): string {
  const sequence = toolSequence.join(' → ');
  
  if (sequence.includes('search_code → read_file → edit_block')) {
    return 'Debugging and fixing code based on search results';
  }
  if (sequence.includes('read_file → edit_block')) {
    return 'Modifying existing code';
  }
  if (sequence.includes('create_directory → write_file')) {
    return 'Setting up new project structure';
  }
  if (sequence.includes('execute_command')) {
    return 'Running tests/builds and validating changes';
  }
  if (sequence.includes('search_files') || sequence.includes('search_code')) {
    return 'Investigating codebase and exploring files';
  }
  
  return 'General development work';
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

// =============================================================================
// Intent Detection Algorithms
// =============================================================================

/**
 * Detect error-driven reactive work patterns
 */
function detectErrorDrivenWork(
  toolSequence: string[], 
  recentArgs: any[], 
  recentFiles: string[], 
  recentExecutions: Array<{command: string, timestamp: Date}>
): IntentSignals | null {
  const evidence: string[] = [];
  let confidence = 0;

  // Check for error-related search terms
  const errorKeywords = ['error', 'bug', 'fail', 'undefined', 'null', 'exception', 'crash', 'broken'];
  const searchTerms = recentArgs
    .filter(args => args && (args.pattern || args.query))
    .map(args => (args.pattern || args.query).toLowerCase());

  for (const term of searchTerms) {
    if (errorKeywords.some(keyword => term.includes(keyword))) {
      evidence.push(`Error-related search term: "${term}"`);
      confidence += 0.3;
    }
  }

  // Check for debugging sequence patterns
  const sequence = toolSequence.join(' → ');
  if (sequence.includes('search_code → read_file → edit_block')) {
    evidence.push('Debugging workflow: search → read → edit');
    confidence += 0.25;
  }

  // Check for test files or error logs
  const hasTestFiles = recentFiles.some(f => 
    f.includes('test') || f.includes('spec') || f.includes('.log')
  );
  if (hasTestFiles) {
    evidence.push('Working with test files or logs');
    confidence += 0.15;
  }

  // Check for failed commands (if we had execution results)
  if (recentExecutions.some(exec => exec.command.includes('test'))) {
    evidence.push('Recent test command execution');
    confidence += 0.2;
  }

  if (confidence >= 0.25) {
    return {
      trigger: 'error_response',
      confidence: Math.min(confidence, 0.9),
      evidence,
      likely_goal: 'Debug and fix identified error or test failure',
      category: 'reactive'
    };
  }

  return null;
}

/**
 * Detect planned development work patterns
 */
function detectPlannedDevelopment(
  toolSequence: string[], 
  recentArgs: any[], 
  recentFiles: string[], 
  recentExecutions: Array<{command: string, timestamp: Date}>
): IntentSignals | null {
  const evidence: string[] = [];
  let confidence = 0;

  // Check for type definition files
  const hasTypeFiles = recentFiles.some(f => 
    f.includes('types.') || f.includes('interface') || f.includes('.d.ts')
  );
  if (hasTypeFiles) {
    evidence.push('Working with type definitions');
    confidence += 0.3;
  }

  // Check for new file creation patterns
  const hasFileCreation = toolSequence.some(tool => 
    tool === 'create_directory' || tool === 'write_file'
  );
  if (hasFileCreation) {
    evidence.push('Creating new files/directories');
    confidence += 0.25;
  }

  // Check for systematic approach (multiple related files)
  if (recentFiles.length >= 3) {
    const extensions = recentFiles.map(f => f.split('.').pop()).filter(Boolean);
    const uniqueExtensions = new Set(extensions);
    if (uniqueExtensions.size >= 2) {
      evidence.push('Working across multiple file types systematically');
      confidence += 0.2;
    }
  }

  // Check for setup/configuration work
  const hasConfigWork = recentFiles.some(f => 
    f.includes('config') || f.includes('package.json') || f.includes('tsconfig')
  );
  if (hasConfigWork) {
    evidence.push('Configuration and setup work');
    confidence += 0.15;
  }

  if (confidence >= 0.25) {
    return {
      trigger: 'planned_work',
      confidence: Math.min(confidence, 0.9),
      evidence,
      likely_goal: 'Implement new feature following planned approach',
      category: 'proactive'
    };
  }

  return null;
}

/**
 * Detect exploratory investigation patterns
 */
function detectExploratoryWork(
  toolSequence: string[], 
  recentArgs: any[], 
  recentFiles: string[], 
  recentExecutions: Array<{command: string, timestamp: Date}>
): IntentSignals | null {
  const evidence: string[] = [];
  let confidence = 0;

  // Check for high read-to-edit ratio
  const readOperations = toolSequence.filter(tool => 
    tool === 'read_file' || tool === 'list_directory' || tool === 'search_files'
  ).length;
  const editOperations = toolSequence.filter(tool => 
    tool === 'edit_block' || tool === 'write_file'
  ).length;

  if (readOperations >= 3 && editOperations <= 1) {
    evidence.push(`High exploration ratio: ${readOperations} reads, ${editOperations} edits`);
    confidence += 0.3;
  }

  // Check for directory traversal patterns
  const hasDirectoryExploration = toolSequence.filter(tool => 
    tool === 'list_directory'
  ).length >= 2;
  if (hasDirectoryExploration) {
    evidence.push('Multiple directory explorations');
    confidence += 0.25;
  }

  // Check for search patterns without immediate editing
  const searchCount = toolSequence.filter(tool => 
    tool === 'search_code' || tool === 'search_files'
  ).length;
  if (searchCount >= 2) {
    evidence.push('Multiple search operations');
    confidence += 0.2;
  }

  // Check for diverse file access
  if (recentFiles.length >= 4) {
    evidence.push(`Exploring multiple files: ${recentFiles.length} files accessed`);
    confidence += 0.15;
  }

  if (confidence >= 0.25) {
    return {
      trigger: 'exploration',
      confidence: Math.min(confidence, 0.9),
      evidence,
      likely_goal: 'Understand codebase structure and identify areas of interest',
      category: 'investigative'
    };
  }

  return null;
}

/**
 * Detect maintenance and refactoring patterns
 */
function detectMaintenanceWork(
  toolSequence: string[], 
  recentArgs: any[], 
  recentFiles: string[], 
  recentExecutions: Array<{command: string, timestamp: Date}>
): IntentSignals | null {
  const evidence: string[] = [];
  let confidence = 0;

  // Check for multiple small edits
  const editCount = toolSequence.filter(tool => tool === 'edit_block').length;
  if (editCount >= 3) {
    evidence.push(`Multiple edits: ${editCount} edit operations`);
    confidence += 0.3;
  }

  // Check for dependency/package work
  const hasDependencyWork = recentFiles.some(f => 
    f.includes('package.json') || f.includes('yarn.lock') || f.includes('node_modules')
  );
  if (hasDependencyWork) {
    evidence.push('Working with dependencies');
    confidence += 0.25;
  }

  // Check for config file modifications
  const hasConfigWork = recentFiles.some(f => 
    f.includes('config') || f.includes('.json') || f.includes('.yml') || f.includes('.yaml')
  );
  if (hasConfigWork) {
    evidence.push('Configuration file modifications');
    confidence += 0.2;
  }

  // Check for build/test commands
  const hasBuildCommands = recentExecutions.some(exec => 
    exec.command.includes('build') || exec.command.includes('npm') || exec.command.includes('yarn')
  );
  if (hasBuildCommands) {
    evidence.push('Build or package management commands');
    confidence += 0.15;
  }

  if (confidence >= 0.25) {
    return {
      trigger: 'maintenance',
      confidence: Math.min(confidence, 0.9),
      evidence,
      likely_goal: 'Perform maintenance, refactoring, or optimization tasks',
      category: 'maintenance'
    };
  }

  return null;
}

/**
 * Main intent detection function that runs all detectors
 */
function detectIntentSignals(
  toolSequence: string[], 
  recentArgs: any[], 
  recentFiles: string[],
  recentExecutions: Array<{command: string, timestamp: Date}>
): IntentSignals | null {
  // Run all detection algorithms
  const detectors = [
    detectErrorDrivenWork,
    detectPlannedDevelopment,
    detectExploratoryWork,
    detectMaintenanceWork
  ];

  let bestIntent: IntentSignals | null = null;
  let bestConfidence = 0;

  for (const detector of detectors) {
    const intent = detector(toolSequence, recentArgs, recentFiles, recentExecutions);
    if (intent && intent.confidence > bestConfidence && intent.confidence >= INTENT_CONFIDENCE_THRESHOLD) {
      bestIntent = intent;
      bestConfidence = intent.confidence;
    }
  }

  return bestIntent;
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
      // Reset intent detection state for new session
      contextState.recentArgs = [];
      contextState.intentSignals = [];
      contextState.workPattern = 'proactive';
    }
    
    // Update context state
    contextState.lastCallTime = timestamp;
    
    // CRITICAL: Track recent arguments for intent detection (FIXES ROOT CAUSE)
    if (args) {
      contextState.recentArgs.push(args);
      if (contextState.recentArgs.length > MAX_RECENT_ARGS) {
        contextState.recentArgs.shift();
      }
    }
    
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
    
    // Capture edit operations for session recovery
    const editContext = extractEditLocation(toolName, args);
    if (editContext) {
      contextState.lastEdit = editContext;
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
    
    // Add edit context if available
    if (contextState.lastEdit) {
      contextInfo.lastEdit = {
        file: path.basename(contextState.lastEdit.file),
        editType: contextState.lastEdit.editType,
        purpose: contextState.lastEdit.purpose
      };
    }
    
    // Add inferred current task
    if (contextState.toolSequence.length >= 2) {
      contextInfo.currentTask = inferCurrentTask(contextState.toolSequence, contextState.recentFiles);
    }
    
    // Add recent search summary
    if (contextState.recentSearches.length > 0) {
      const searchSummary = contextState.recentSearches.slice(-3).map(s => 
        `${s.toolName}:"${s.query}"`
      ).join(', ');
      contextInfo.recentSearches = searchSummary;
    }
    
    // =============================================================================
    // INTENT DETECTION INTEGRATION - The core intelligence
    // =============================================================================
    
    // Detect intent when we have enough context (2+ tools)
    if (contextState.toolSequence.length >= 2) {
      const intentSignal = detectIntentSignals(
        contextState.toolSequence,
        contextState.recentArgs.filter(Boolean), // Filter out null/undefined args
        contextState.recentFiles,
        [] // Recent executions - would need command result feedback for full functionality
      );
      
      if (intentSignal && intentSignal.confidence >= INTENT_CONFIDENCE_THRESHOLD) {
        // Store intent signal
        contextState.intentSignals.push(intentSignal);
        if (contextState.intentSignals.length > MAX_INTENT_SIGNALS) {
          contextState.intentSignals.shift();
        }
        
        // Update work pattern
        contextState.workPattern = intentSignal.category;
        
        // Add intent information to context
        contextInfo.intent = intentSignal.likely_goal;
        contextInfo.intentConfidence = Math.round(intentSignal.confidence * 100);
        contextInfo.workPattern = intentSignal.category;
        contextInfo.intentEvidence = intentSignal.evidence;
      }
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
