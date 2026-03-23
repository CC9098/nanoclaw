/**
 * Memory Monitor for NanoClaw
 * 1. Detects when the agent fails to update brain/ files after a conversation,
 *    and spawns a lightweight "memory writer" to fix it.
 * 2. Manages session rotation — periodically starts fresh sessions so context
 *    doesn't accumulate indefinitely. Brain/ files serve as long-term memory.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { runContainerAgent } from './container-runner.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { NewMessage, RegisteredGroup } from './types.js';

const MEMORY_MISS_MIN_MESSAGES = 3;

/**
 * Session rotation interval in milliseconds.
 * After this period, the next conversation starts a fresh session instead of
 * resuming the old one. Brain/ files provide long-term context.
 * Default: 24 hours.
 */
const SESSION_ROTATION_INTERVAL = parseInt(
  process.env.SESSION_ROTATION_INTERVAL || String(24 * 60 * 60 * 1000),
  10,
);

/** Tracks when each group's session was last rotated. */
const sessionStartTimes = new Map<string, number>();

const MEMORY_WRITER_PROMPT = `You are a memory extraction agent. Your ONLY job is to read a conversation transcript and update the brain/ knowledge base.

Read the conversation transcript at: {transcriptPath}

Then read /workspace/group/CLAUDE.md to understand the brain/ structure and update rules.

Follow the "自動記憶規則" section exactly:
1. Update Tasks.md if any tasks were discussed, created, or completed
2. Update relevant Project files in Projects/ with progress notes
3. Update relevant People files in People/ with new information
4. Create/update Daily/YYYY-MM-DD.md with today's actions
5. Create Decision files in Decisions/ for important decisions

Rules:
- If the conversation was casual chat with no actionable content, write nothing
- Do NOT create any output text — your result should be empty
- Do NOT send any messages to users
- ONLY read the transcript and write to brain/ files
- If referenced brain files don't exist, create them following CLAUDE.md templates`;

/** Set of group names currently running a memory writer — prevents concurrent writes. */
const activeMemoryWriters = new Set<string>();

/**
 * Recursively reads all files under brainDir and returns a Map of
 * relativePath -> sha256 content hash.
 */
export function snapshotBrain(brainDir: string): Map<string, string> {
  const snapshot = new Map<string, string>();

  if (!fs.existsSync(brainDir)) {
    return snapshot;
  }

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(brainDir, fullPath);
        const content = fs.readFileSync(fullPath);
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        snapshot.set(relativePath, hash);
      }
    }
  }

  walk(brainDir);
  return snapshot;
}

/**
 * Compares two brain snapshots. Returns true if any file was added, modified, or deleted.
 */
function brainChanged(
  before: Map<string, string>,
  after: Map<string, string>,
): boolean {
  if (before.size !== after.size) return true;

  for (const [filePath, hash] of after) {
    if (before.get(filePath) !== hash) return true;
  }

  for (const filePath of before.keys()) {
    if (!after.has(filePath)) return true;
  }

  return false;
}

/**
 * Writes a temporary markdown file at `{groupDir}/conversations/_pending-memory.md`
 * from the raw messages. Caps at 50 most recent messages to keep the file manageable.
 * Returns the container-relative path.
 */
function writePendingTranscript(
  groupDir: string,
  messages: NewMessage[],
): string {
  const conversationsDir = path.join(groupDir, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });

  const lines: string[] = ['# Pending Memory Transcript', ''];

  // Cap to most recent 50 messages to keep transcript manageable
  const recentMessages = messages.slice(-50);

  for (const msg of recentMessages) {
    lines.push(`## ${msg.sender} (${msg.timestamp})`);
    lines.push('');
    lines.push(msg.content);
    lines.push('');
  }

  const filePath = path.join(conversationsDir, '_pending-memory.md');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

  return '/workspace/group/conversations/_pending-memory.md';
}

/**
 * Spawns a container using runContainerAgent with a focused memory-extraction prompt.
 * Fire-and-forget — catches all errors and logs them.
 */
async function runMemoryWriter(
  group: RegisteredGroup,
  transcriptContainerPath: string,
): Promise<void> {
  const prompt = MEMORY_WRITER_PROMPT.replace(
    '{transcriptPath}',
    transcriptContainerPath,
  );

  const groupDir = resolveGroupFolderPath(group.folder);
  const pendingFile = path.join(
    groupDir,
    'conversations',
    '_pending-memory.md',
  );

  try {
    await runContainerAgent(
      group,
      {
        prompt,
        groupFolder: group.folder,
        chatJid: '__memory_writer__',
        isMain: !!group.isMain,
        isScheduledTask: true,
      },
      () => {
        // onProcess: no-op
      },
      async () => {
        // onOutput: no-op — memory writer should not send messages to users
      },
    );
  } catch (err) {
    logger.error({ err, group: group.name }, 'Memory writer failed');
  } finally {
    try {
      if (fs.existsSync(pendingFile)) {
        fs.unlinkSync(pendingFile);
      }
    } catch (cleanupErr) {
      logger.warn(
        { err: cleanupErr, path: pendingFile },
        'Failed to clean up pending memory transcript',
      );
    }
  }
}

/**
 * Top-level function: checks whether brain/ was updated after a conversation,
 * and if not, spawns a memory writer to extract and persist knowledge.
 */
export function checkMemoryAndRepair(
  group: RegisteredGroup,
  messageCount: number,
  beforeSnapshot: Map<string, string>,
  messages: NewMessage[],
): void {
  const groupDir = resolveGroupFolderPath(group.folder);
  const brainDir = path.join(groupDir, 'brain');

  const afterSnapshot = snapshotBrain(brainDir);

  if (brainChanged(beforeSnapshot, afterSnapshot)) {
    logger.debug({ group: group.name }, 'Brain updated during conversation');
    return;
  }

  if (messageCount <= MEMORY_MISS_MIN_MESSAGES) {
    logger.debug(
      { group: group.name, messageCount },
      'Conversation too short to expect memory updates — skipping',
    );
    return;
  }

  logger.info(
    { group: group.name, messageCount },
    'Memory miss detected — spawning memory writer',
  );

  if (activeMemoryWriters.has(group.name)) {
    logger.info(
      { group: group.name },
      'Memory writer already active for group — skipping',
    );
    return;
  }

  const transcriptContainerPath = writePendingTranscript(groupDir, messages);

  activeMemoryWriters.add(group.name);

  runMemoryWriter(group, transcriptContainerPath)
    .catch((err) => {
      logger.error(
        { err, group: group.name },
        'Memory writer unexpected error',
      );
    })
    .finally(() => {
      activeMemoryWriters.delete(group.name);
    });
}

/**
 * Determines whether the current session should be rotated (start fresh).
 * Returns the sessionId to use: the existing one, or undefined to start fresh.
 *
 * When a session is rotated:
 * - The agent starts with no prior conversation context
 * - Brain/ files (loaded via CLAUDE.md) provide all long-term memory
 * - Token usage drops significantly (no stale context to load)
 *
 * Session rotation happens when:
 * - The session has been active longer than SESSION_ROTATION_INTERVAL
 * - Or the session has never been tracked (first run after deploy)
 */
export function getSessionWithRotation(
  groupFolder: string,
  currentSessionId: string | undefined,
): string | undefined {
  const now = Date.now();
  const startTime = sessionStartTimes.get(groupFolder);

  // First time seeing this group — track the session start, don't rotate
  if (!startTime) {
    sessionStartTimes.set(groupFolder, now);
    return currentSessionId;
  }

  const elapsed = now - startTime;

  if (elapsed >= SESSION_ROTATION_INTERVAL) {
    logger.info(
      {
        group: groupFolder,
        elapsedHours: Math.round((elapsed / (60 * 60 * 1000)) * 10) / 10,
        intervalHours: SESSION_ROTATION_INTERVAL / (60 * 60 * 1000),
      },
      'Session rotation — starting fresh session (brain/ provides long-term memory)',
    );
    sessionStartTimes.set(groupFolder, now);
    return undefined; // No sessionId = fresh session
  }

  return currentSessionId;
}
