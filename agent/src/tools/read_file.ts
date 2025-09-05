import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

export function createReadFileTool(workDir: string, sendMessage: (message: any) => void) {
  return tool({
    description: 'Read the contents of a file',
    inputSchema: z.object({
      path: z.string().describe('Path to the file relative to working directory'),
      encoding: z.enum(['utf8', 'base64']).default('utf8').describe('File encoding')
    }),
    execute: async ({ path: filePath, encoding }) => {
      sendMessage({
        type: 'tool_call',
        data: { toolName: 'read_file', args: { path: filePath, encoding } }
      });
      
      const fullPath = path.resolve(workDir, filePath);
      console.error(`[Tool] Reading file: ${fullPath}`);
      
      try {
        const content = await fs.readFile(fullPath, encoding);
        const stats = await fs.stat(fullPath);
        return {
          path: filePath,
          content,
          size: stats.size,
          modified: stats.mtime.toISOString()
        };
      } catch (error: any) {
        return { error: error.message, path: filePath };
      }
    }
  });
}